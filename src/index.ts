/**
 * Cloudflare Worker for receiving GitHub webhooks and adding them to a queue
 */

/// <reference types="@cloudflare/workers-types" />

import { Env, GitHubEventType, GitHubWebhookPayload, QueueResponse, TaskQueueMessage, GitHubMetadata, TaskUpdateRequest } from './types';
import { verifyGitHubSignature } from './utils/auth';
import { formatTaskMessage, validateAndFilterWebhook } from './utils/queue';
// order of message types is important as
// if a message matches multiple types, the first one will be used
const MESSAGE_TYPES = [
  {
    // An update to a tracked Github repository
    'key': 'github_webhook',
    identifier: (request: Request) => {
      const eventType = request.headers.get('X-GitHub-Event') as GitHubEventType;
      const deliveryId = request.headers.get('X-GitHub-Delivery');
      if (!eventType || !deliveryId) {
        return false;
      }
      return `${eventType}-${deliveryId}`;
    }
  }
];
/**
 * Return queue items with count (max 25)
 */
async function handleQueueReturn(env: Env): Promise<Response> {
  try {
    // Query pending tasks from database, limiting to 25
    const stmt = env.TASK_DB.prepare(
      `SELECT id, event_type, payload, signature, created_at 
       FROM tasks 
       WHERE status = 'pending' 
       ORDER BY created_at ASC 
       LIMIT 25`
    );
    
    const result = await stmt.all();
    
    // Transform database results to TaskQueueMessage format
    const items: TaskQueueMessage[] = result.results.map((row: any) => {
      const storedMessage = JSON.parse(row.payload);
      return {
        eventType: row.event_type,
        payload: storedMessage.payload,
        metadata: storedMessage.metadata
      };
    });

    const response: QueueResponse = {
      items,
      count: items.length,
      timestamp: new Date().toISOString()
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });

  } catch (error) {
    console.error('Error retrieving queue:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Get a specific task by ID
 */
async function handleGetTask(taskId: string, env: Env): Promise<Response> {
  try {
    const stmt = env.TASK_DB.prepare(
      `SELECT id, event_type, payload, signature, status, created_at, updated_at 
       FROM tasks 
       WHERE id = ?`
    );
    
    const result = await stmt.bind(taskId).first();
    
    if (!result) {
      return new Response('Task not found', { status: 404 });
    }
    
    const storedMessage = JSON.parse(result.payload as string);
    const task = {
      id: result.id,
      eventType: result.event_type,
      payload: storedMessage.payload,
      metadata: storedMessage.metadata,
      status: result.status,
      createdAt: result.created_at,
      updatedAt: result.updated_at
    };

    return new Response(JSON.stringify(task), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });

  } catch (error) {
    console.error('Error retrieving task:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Update a specific task by ID
 */
async function handleUpdateTask(taskId: string, request: Request, env: Env): Promise<Response> {
  try {
    // Parse the update request
    const updateData: TaskUpdateRequest = await request.json();
    
    // Build dynamic UPDATE query based on provided fields
    const updates: string[] = [];
    const values: any[] = [];
    
    if (updateData.status !== undefined) {
      updates.push('status = ?');
      values.push(updateData.status);
    }
    
    if (updateData.metadata !== undefined) {
      // First, get the current task to preserve the payload
      const currentStmt = env.TASK_DB.prepare('SELECT payload FROM tasks WHERE id = ?');
      const currentResult = await currentStmt.bind(taskId).first();
      
      if (!currentResult) {
        return new Response('Task not found', { status: 404 });
      }
      
      const currentMessage = JSON.parse(currentResult.payload as string);
      const updatedMessage = {
        ...currentMessage,
        metadata: updateData.metadata
      };
      
      updates.push('payload = ?');
      values.push(JSON.stringify(updatedMessage));
    }
    
    if (updates.length === 0) {
      return new Response('No valid fields to update', { status: 400 });
    }
    
    // Add updated_at timestamp
    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    
    // Add taskId for WHERE clause
    values.push(taskId);
    
    const stmt = env.TASK_DB.prepare(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`
    );
    
    const result = await stmt.bind(...values).run();
    
    if (result.meta.changes === 0) {
      return new Response('Task not found', { status: 404 });
    }

    return new Response(JSON.stringify({
      status: 'success',
      message: 'Task updated successfully',
      taskId: taskId
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });

  } catch (error) {
    console.error('Error updating task:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Process incoming GitHub webhook requests
 */
async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Check for POST method
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const messageType = MESSAGE_TYPES.find((type) => type.identifier(request));

  switch (messageType?.key) {
    case 'github_webhook':
      // Get headers
      const eventType = request.headers.get('X-GitHub-Event') as GitHubEventType;
      const deliveryId = request.headers.get('X-GitHub-Delivery');
      const signature = request.headers.get('X-Hub-Signature-256');
      // this is where we would verify the webhook signature if it wasn't done by the type selector

      // Get request body
      const rawBody = await request.text();

      // Verify webhook signature if a secret is configured
      // TODO: allow multiple secrets mapped to different repositories (low priority)
      if (env.GITHUB_WEBHOOK_SECRET) {
        const isValid = await verifyGitHubSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET);
        if (!isValid) {
          console.error(`Invalid webhook signature for delivery ${deliveryId}`);
          return new Response('Unauthorized', { status: 401 });
        }
      }

      try {
        // Parse payload
        const payload = JSON.parse(rawBody) as GitHubWebhookPayload;

        // Validate and filter the webhook
        const validationResult = validateAndFilterWebhook(eventType, payload);
        if (!validationResult.isValid) {
          console.error(`Invalid webhook: ${validationResult.reason} for delivery ${deliveryId}`);
          return new Response(`Bad request - ${validationResult.reason || 'invalid payload'}`, { status: 400 });
        }

        // Create task message
        const message = formatTaskMessage(eventType, payload, deliveryId || undefined, signature || undefined);

        // Generate a unique ID for the task
        const taskId = crypto.randomUUID();
        
        // Insert task into database
        const stmt = env.TASK_DB.prepare(
          `INSERT INTO tasks (id, event_type, payload, signature, status, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`
        );

        await stmt.bind(
          taskId,
          `webhook-${eventType}`,
          JSON.stringify(message),
          signature || null,
          new Date().toISOString()
        ).run();

        // Log success
        console.log(`Stored ${eventType} event for ${payload.repository?.full_name} with ID ${taskId}`);
        
        return new Response(JSON.stringify({
          status: 'success',
          message: 'Event added to processing queue',
          taskId: taskId
        }), {
          status: 201,
          headers: {
            'Content-Type': 'application/json'
          }
        });

      } catch (error) {
        console.error('Error processing webhook:', error);
        return new Response('Internal server error', { status: 500 });
      }
    default:
      return new Response('Not a valid message type', { status: 400 });
  }
}

/**
 * Main entry point for all requests
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle webhook endpoint
    if (url.pathname === '/task-queue') {
      return handleWebhook(request, env, ctx);
    }
    
    // Handle queue return endpoint  
    if (url.pathname === '/queue' && request.method === 'GET') {
      return handleQueueReturn(env);
    }
    
    // Handle task-specific endpoints
    const taskMatch = url.pathname.match(/^\/task\/(.+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      
      if (request.method === 'GET') {
        return handleGetTask(taskId, env);
      }
      
      if (request.method === 'PUT') {
        return handleUpdateTask(taskId, request, env);
      }
      
      return new Response('Method not allowed', { status: 405 });
    }
    
    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        version: '0.1.0',
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // Not found for other routes
    return new Response('Not found', { status: 404 });
  }
};

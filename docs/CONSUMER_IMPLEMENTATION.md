# Task Consumer Implementation Guide

This document provides guidance on implementing a task consumer agent that will fetch and process tasks from the webhook queue.

## Basic Consumer Implementation

Below is a sample implementation of a consumer agent in TypeScript that:

1. Polls the task queue for pending tasks
2. Processes tasks based on their event type
3. Updates task status accordingly

```typescript
// sample-consumer.ts
import axios from 'axios';

// Configuration
const API_BASE_URL = 'https://your-worker.workers.dev';
const AGENT_NAME = 'sample-agent';
const POLLING_INTERVAL = 30000; // 30 seconds

// Type definitions
interface Task {
  id: string;
  event_type: string;
  payload: string;
  signature?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
}

interface TaskPayload {
  eventType: string;
  timestamp: string;
  payload: any;
  deliveryId?: string;
  signature?: string;
}

// Start polling for tasks
async function startTaskPolling() {
  console.log('Task consumer started');
  
  while (true) {
    try {
      await processNextBatchOfTasks();
    } catch (error) {
      console.error('Error processing tasks:', error);
    }
    
    // Wait before next polling
    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
  }
}

// Process a batch of pending tasks
async function processNextBatchOfTasks() {
  console.log('Polling for pending tasks...');
  
  // Fetch pending tasks
  const response = await axios.get(`${API_BASE_URL}/tasks?status=pending&limit=5`);
  const { tasks } = response.data;
  
  if (tasks.length === 0) {
    console.log('No pending tasks found');
    return;
  }
  
  console.log(`Found ${tasks.length} pending tasks`);
  
  // Process each task
  for (const task of tasks) {
    await processTask(task);
  }
}

// Process an individual task
async function processTask(task: Task) {
  console.log(`Processing task ${task.id} (${task.event_type})`);
  
  try {
    // Mark task as being processed
    await updateTaskStatus(task.id, 'processing');
    
    // Parse the payload
    const taskPayload: TaskPayload = JSON.parse(task.payload);
    
    // Process based on event type
    const success = await handleEventByType(task.event_type, taskPayload);
    
    // Update task status based on processing result
    await updateTaskStatus(task.id, success ? 'completed' : 'failed');
    
    console.log(`Task ${task.id} processed with status: ${success ? 'completed' : 'failed'}`);
  } catch (error) {
    console.error(`Error processing task ${task.id}:`, error);
    await updateTaskStatus(task.id, 'failed');
  }
}

// Update task status in API
async function updateTaskStatus(taskId: string, status: 'pending' | 'processing' | 'completed' | 'failed') {
  await axios.post(`${API_BASE_URL}/tasks/${taskId}/status`, {
    status,
    processing_agent: AGENT_NAME
  });
}

// Handle different event types
async function handleEventByType(eventType: string, taskPayload: TaskPayload): Promise<boolean> {
  // Extract the GitHub webhook payload
  const githubPayload = taskPayload.payload;
  
  switch (eventType) {
    case 'push':
      return await handlePushEvent(githubPayload);
      
    case 'pull_request':
      return await handlePullRequestEvent(githubPayload);
      
    case 'issues':
      return await handleIssuesEvent(githubPayload);
      
    case 'issue_comment':
      return await handleIssueCommentEvent(githubPayload);
    
    // Add handlers for new event types here
      
    default:
      console.warn(`No handler for event type: ${eventType}`);
      return false;
  }
}

// Event type handlers
async function handlePushEvent(payload: any): Promise<boolean> {
  // Implementation for push events
  console.log(`Processing push event for ${payload.repository?.full_name}`);
  
  // Your implementation here
  // - Clone/pull repository
  // - Run scripts or tests
  // - Trigger CI/CD
  // - etc.
  
  return true;
}

async function handlePullRequestEvent(payload: any): Promise<boolean> {
  // Implementation for pull request events
  console.log(`Processing pull request event for ${payload.repository?.full_name} #${payload.number}`);
  
  // Your implementation here
  
  return true;
}

async function handleIssuesEvent(payload: any): Promise<boolean> {
  // Implementation for issues events
  console.log(`Processing issue event for ${payload.repository?.full_name} #${payload.issue?.number}`);
  
  // Your implementation here
  
  return true;
}

async function handleIssueCommentEvent(payload: any): Promise<boolean> {
  // Implementation for issue comment events
  console.log(`Processing issue comment for ${payload.repository?.full_name} #${payload.issue?.number}`);
  
  // Your implementation here
  
  return true;
}

// Start the consumer
startTaskPolling().catch(console.error);
```

## Adding a New Event Type Handler

To add support for a new event type in your consumer:

1. Update your `handleEventByType` function:

```typescript
async function handleEventByType(eventType: string, taskPayload: TaskPayload): Promise<boolean> {
  const githubPayload = taskPayload.payload;
  
  switch (eventType) {
    // Existing cases...
    
    case 'your_new_event_type':
      return await handleNewEventType(githubPayload);
      
    default:
      console.warn(`No handler for event type: ${eventType}`);
      return false;
  }
}
```

2. Implement the handler function:

```typescript
async function handleNewEventType(payload: any): Promise<boolean> {
  console.log(`Processing new event type for ${payload.repository?.full_name}`);
  
  // Your implementation specific to this event type
  // Access relevant fields from the payload
  
  return true;
}
```

## Error Handling Best Practices

1. **Transient failures**: Consider implementing retry logic for network errors
2. **Idempotency**: Ensure handlers are idempotent to avoid problems if the same task is processed multiple times
3. **Logging**: Maintain detailed logs of task processing for debugging
4. **Monitoring**: Track metrics like success rate, processing time, and error counts

```typescript
// Example of retry logic
async function processTaskWithRetry(task: Task, maxRetries = 3) {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      await processTask(task);
      return; // Success, exit the function
    } catch (error) {
      retries++;
      
      if (retries >= maxRetries) {
        console.error(`Failed to process task ${task.id} after ${maxRetries} attempts`);
        await updateTaskStatus(task.id, 'failed');
        throw error;
      }
      
      console.warn(`Retry ${retries}/${maxRetries} for task ${task.id}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
}
```

## Deployment Considerations

1. **Service reliability**: Consider running your consumer as a daemon or service
2. **Multiple consumers**: You can run multiple consumers in different regions for redundancy
3. **Rate limiting**: Be mindful of Cloudflare's API rate limits
4. **Task prioritization**: Consider implementing priority for certain event types or repositories

## Security Best Practices

1. **API token security**: Store API tokens securely, never hardcode them
2. **Payload validation**: Always validate the payload before processing
3. **Separation of concerns**: Each handler should only have the permissions it needs
4. **Audit trail**: Log all actions for security auditing
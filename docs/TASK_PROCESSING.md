# Task Queue Processing System

This document explains how webhook events are processed through our system, from reception to processing. It also provides guidance on adding new event types.

## System Architecture

```
GitHub Webhook → Cloudflare Worker → D1 Database ← Consumer API → Local Processing Agent
                  (queue-receiver)      (storage)    (endpoints)     (your agent)
```

## How It Works

1. **GitHub sends a webhook** to our Cloudflare Worker endpoint (`/task-queue`)
2. The Worker **validates** the webhook payload and signature
3. Valid events are **stored** in the D1 database with a unique ID
4. Local agents **query** the API for pending tasks
5. Agents **process** tasks and update their status via the API

## Adding a New Event Type

To add support for a new GitHub webhook event type:

### 1. Update Event Types

In `/src/types.ts`, add the new event type to the `GitHubEventType` union type:

```typescript
export type GitHubEventType = 
  | 'push'
  | 'pull_request'
  | 'issues'
  | 'issue_comment'
  | 'your_new_event_type'; // Add your new event type here
```

### 2. Update Webhook Validation

In `/src/utils/queue.ts`, update the `validateAndFilterWebhook` function to properly validate the new event type:

```typescript
export function validateAndFilterWebhook(
  eventType: GitHubEventType,
  payload: GitHubWebhookPayload
): ValidationResult {
  // Existing validation logic...

  // Add validation for your new event type
  if (eventType === 'your_new_event_type') {
    // Validate the payload has the expected fields for this event type
    if (!payload.specific_field_for_this_event) {
      return { isValid: false, reason: 'Missing required fields for your_new_event_type' };
    }

    // Any other validation specific to this event type
    // ...
  }

  return { isValid: true };
}
```

### 3. Test Webhook Reception

Send a test webhook of the new event type to your endpoint and verify:
- The webhook is properly validated
- The event is stored in the D1 database
- The response indicates success

### 4. Implement Event Processing

In your local agent that processes tasks:

```typescript
async function processTasks() {
  // Fetch tasks from the API
  const response = await fetch('https://your-worker.workers.dev/tasks?status=pending');
  const { tasks } = await response.json();
  
  for (const task of tasks) {
    try {
      // Mark the task as processing
      await updateTaskStatus(task.id, 'processing', 'my-agent-name');
      
      // Parse the task payload
      const { eventType, payload } = JSON.parse(task.payload);
      
      // Process based on event type
      if (eventType === 'your_new_event_type') {
        // Handle your new event type here
        await processNewEventType(payload);
      }
      
      // Mark task as completed
      await updateTaskStatus(task.id, 'completed', 'my-agent-name');
    } catch (error) {
      // Mark task as failed
      await updateTaskStatus(task.id, 'failed', 'my-agent-name');
      console.error(`Failed to process task ${task.id}:`, error);
    }
  }
}

async function updateTaskStatus(taskId, status, agentName) {
  await fetch(`https://your-worker.workers.dev/tasks/${taskId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, processing_agent: agentName })
  });
}
```

## API Reference

### Webhook Endpoint

- **URL**: `/task-queue`
- **Method**: POST
- **Required Headers**:
  - `X-GitHub-Event`: Event type
  - `X-GitHub-Delivery`: Unique delivery ID
  - `X-Hub-Signature-256`: HMAC signature (if secret is configured)

### Task Management Endpoints

#### List Tasks

- **URL**: `/tasks?status=[status]&limit=[limit]`
- **Method**: GET
- **Query Parameters**:
  - `status`: Filter tasks by status (default: 'pending')
  - `limit`: Maximum number of tasks to return (default: 10)

#### Get Task by ID

- **URL**: `/tasks/:id`
- **Method**: GET

#### Update Task Status

- **URL**: `/tasks/:id/status`
- **Method**: POST
- **Body**:
  ```json
  {
    "status": "pending|processing|completed|failed",
    "processing_agent": "your-agent-name"
  }
  ```

## Database Schema

The D1 database uses the following schema:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON including delivery_id and timestamp
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  processing_agent TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL
);
```

## Troubleshooting

### Common Issues

1. **Invalid webhook signature**: Ensure your webhook secret matches the one configured in GitHub
2. **Missing payload fields**: Check that the webhook payload has all expected fields
3. **Database connection issues**: Verify Cloudflare D1 is properly configured in wrangler.toml
4. **Task processing failures**: Check that your local agent is properly handling the task payload format
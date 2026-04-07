import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import type { IndexDocumentInput } from "../../workflows/indexDocument";

export interface IndexingWorkflowClientOptions {
  temporalAddress?: string;
}

export interface StartIndexDocumentWorkflowOptions {
  client: Client;
  taskQueue: string;
  workflowId: string;
  input: IndexDocumentInput;
}

export interface StartIndexDocumentWorkflowResult {
  handle?: Awaited<ReturnType<Client["workflow"]["start"]>>;
  started: boolean;
  skippedBecauseRunning: boolean;
}

export async function connectTemporal(
  options: IndexingWorkflowClientOptions = {}
): Promise<{ connection: Connection; client: Client }> {
  const connection = await Connection.connect({
    address: options.temporalAddress ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  return {
    connection,
    client: new Client({ connection }),
  };
}

export function getTaskQueue(): string {
  return process.env.TEMPORAL_TASK_QUEUE ?? "unconcealment-indexing";
}

export async function startIndexDocumentWorkflow(
  options: StartIndexDocumentWorkflowOptions
): Promise<StartIndexDocumentWorkflowResult> {
  try {
    const handle = await options.client.workflow.start("indexDocument", {
      taskQueue: options.taskQueue,
      workflowId: options.workflowId,
      args: [options.input],
    });

    return {
      handle,
      started: true,
      skippedBecauseRunning: false,
    };
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
      throw error;
    }

    return {
      started: false,
      skippedBecauseRunning: true,
    };
  }
}

import { Worker, NativeConnection } from "@temporalio/worker";
import * as activities from "./activities";
import { loadManifest } from "./config/manifest";

async function run(): Promise<void> {
  const manifest = loadManifest();
  const taskQueue =
    process.env.TEMPORAL_TASK_QUEUE ?? "unconcealment-indexing";

  console.log("Starting unconcealment indexing worker");
  console.log(
    `Datasets: ${manifest.datasets.map((d) => d.id).join(", ")}`
  );
  console.log(`Task queue: ${taskQueue}`);

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue,
    workflowsPath: require.resolve("./workflows/indexDocument"),
    activities,
  });

  await worker.run();
}

run().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});

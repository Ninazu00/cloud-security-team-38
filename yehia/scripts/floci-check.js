import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { EventBridgeClient, PutRuleCommand, DeleteRuleCommand } from "@aws-sdk/client-eventbridge";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";

const config = {
  endpoint: process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:4566",
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  },
};

async function check(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.name} - ${err.message}`);
  }
}

await check("DynamoDB (ListTables)", async () => {
  const client = new DynamoDBClient(config);
  await client.send(new ListTablesCommand({}));
});

await check("SQS (Create + Describe + Delete Queue)", async () => {
  const client = new SQSClient(config);
  const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: "floci-probe-queue" }));
  await client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }));
  await client.send(new DeleteQueueCommand({ QueueUrl }));
});

await check("EventBridge (PutRule + DeleteRule)", async () => {
  const client = new EventBridgeClient(config);
  await client.send(new PutRuleCommand({
    Name: "floci-probe-rule",
    EventPattern: JSON.stringify({ source: ["catalogue.service"] }),
  }));
  await client.send(new DeleteRuleCommand({ Name: "floci-probe-rule" }));
});

await check("CloudWatch Logs (DescribeLogGroups)", async () => {
  const client = new CloudWatchLogsClient(config);
  await client.send(new DescribeLogGroupsCommand({}));
});

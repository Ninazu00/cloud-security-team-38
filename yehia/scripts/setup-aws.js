import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";

const config = {
  endpoint: process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:4566",
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  },
};

const ddb = new DynamoDBClient(config);
const sqs = new SQSClient(config);
const eb = new EventBridgeClient(config);
const cw = new CloudWatchLogsClient(config);

async function ensureTable(params) {
  try {
    await ddb.send(new CreateTableCommand(params));
    console.log(`[CREATED] DynamoDB table: ${params.TableName}`);
  } catch (err) {
    if (err.name === "ResourceInUseException") {
      console.log(`[EXISTS]  DynamoDB table: ${params.TableName}`);
    } else {
      throw err;
    }
  }
}

await ensureTable({
  TableName: process.env.TIMETABLES_TABLE || "timetables",
  BillingMode: "PAY_PER_REQUEST",
  KeySchema: [
    { AttributeName: "userId", KeyType: "HASH" },
    { AttributeName: "timetableId", KeyType: "RANGE" },
  ],
  AttributeDefinitions: [
    { AttributeName: "userId", AttributeType: "S" },
    { AttributeName: "timetableId", AttributeType: "S" },
  ],
});

await ensureTable({
  TableName: process.env.SECTION_INDEX_TABLE || "section_timetables",
  BillingMode: "PAY_PER_REQUEST",
  KeySchema: [
    { AttributeName: "sectionId", KeyType: "HASH" },
    { AttributeName: "userTimetableKey", KeyType: "RANGE" },
  ],
  AttributeDefinitions: [
    { AttributeName: "sectionId", AttributeType: "S" },
    { AttributeName: "userTimetableKey", AttributeType: "S" },
  ],
});

const queueName = process.env.SECTION_EVENTS_QUEUE || "timetable-section-events";
const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
const { Attributes } = await sqs.send(
  new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] })
);
console.log(`[READY]   SQS queue: ${queueName} (${Attributes.QueueArn})`);

const ruleName = process.env.EVENT_RULE_NAME || "catalogue-section-changed";
await eb.send(
  new PutRuleCommand({
    Name: ruleName,
    EventPattern: JSON.stringify({
      source: ["catalogue.service"],
      "detail-type": ["section.updated", "section.deleted", "section.archived"],
    }),
    State: "ENABLED",
  })
);
await eb.send(
  new PutTargetsCommand({
    Rule: ruleName,
    Targets: [{ Id: "timetable-sqs-target", Arn: Attributes.QueueArn }],
  })
);
console.log(`[READY]   EventBridge rule: ${ruleName} -> ${queueName}`);

const logGroupName = process.env.LOG_GROUP_NAME || "/timetable-service/app";
try {
  await cw.send(new CreateLogGroupCommand({ logGroupName }));
  console.log(`[CREATED] CloudWatch LogGroup: ${logGroupName}`);
} catch (err) {
  if (err.name === "ResourceAlreadyExistsException") {
    console.log(`[EXISTS]  CloudWatch LogGroup: ${logGroupName}`);
  } else {
    throw err;
  }
}

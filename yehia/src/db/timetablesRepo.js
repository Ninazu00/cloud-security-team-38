import { getAwsClientConfig } from "./awsConfig.js";
import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(getAwsClientConfig())
);

const TIMETABLES_TABLE = () => process.env.TIMETABLES_TABLE || "timetables";
const INDEX_TABLE = () => process.env.SECTION_INDEX_TABLE || "section_timetables";

export async function createTimetable({ userId, name, sectionIds }) {
  const timetableId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const cleanSectionIds = [...new Set(sectionIds.map(String))];

  const item = {
    userId: String(userId),
    timetableId,
    name,
    sectionIds: cleanSectionIds,
    stale: false,
    outdatedSectionIds: [],
    createdAt,
  };

  await ddb.send(new PutCommand({ TableName: TIMETABLES_TABLE(), Item: item }));

  await Promise.all(
    cleanSectionIds.map((sectionId) =>
      ddb.send(
        new PutCommand({
          TableName: INDEX_TABLE(),
          Item: {
            sectionId,
            userTimetableKey: `${item.userId}#${timetableId}`,
            userId: item.userId,
            timetableId,
          },
        })
      )
    )
  );

  return item;
}

export async function listTimetables(userId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TIMETABLES_TABLE(),
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": String(userId) },
    })
  );
  return res.Items || [];
}

export async function getTimetable(userId, timetableId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: TIMETABLES_TABLE(),
      Key: { userId: String(userId), timetableId: String(timetableId) },
    })
  );
  return res.Item || null;
}

export async function deleteTimetable(userId, timetableId) {
  const existing = await getTimetable(userId, timetableId);
  if (!existing) return false;

  await ddb.send(
    new DeleteCommand({
      TableName: TIMETABLES_TABLE(),
      Key: { userId: String(userId), timetableId: String(timetableId) },
    })
  );

  await Promise.all(
    (existing.sectionIds || []).map((sectionId) =>
      ddb.send(
        new DeleteCommand({
          TableName: INDEX_TABLE(),
          Key: {
            sectionId: String(sectionId),
            userTimetableKey: `${existing.userId}#${existing.timetableId}`,
          },
        })
      )
    )
  );

  return true;
}

export async function markSectionChanged(sectionId) {
  const sid = String(sectionId);
  const res = await ddb.send(
    new QueryCommand({
      TableName: INDEX_TABLE(),
      KeyConditionExpression: "sectionId = :sid",
      ExpressionAttributeValues: { ":sid": sid },
    })
  );

  const refs = res.Items || [];
  let updatedCount = 0;

  for (const ref of refs) {
    const tt = await getTimetable(ref.userId, ref.timetableId);
    if (!tt) continue;

    const outdated = new Set(tt.outdatedSectionIds || []);
    outdated.add(sid);

    await ddb.send(
      new UpdateCommand({
        TableName: TIMETABLES_TABLE(),
        Key: { userId: ref.userId, timetableId: ref.timetableId },
        UpdateExpression: "SET stale = :s, outdatedSectionIds = :ids",
        ExpressionAttributeValues: { ":s": true, ":ids": [...outdated] },
      })
    );
    updatedCount++;
  }

  return updatedCount;
}

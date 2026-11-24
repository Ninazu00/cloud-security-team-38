export function getAwsClientConfig() {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return {};
  }
  return {
    endpoint: process.env.AWS_ENDPOINT_URL || "http://127.0.0.1:4566",
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
    },
  };
}

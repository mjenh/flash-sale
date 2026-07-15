import mongoose from "mongoose";

export async function connectMongo(
  uri: string,
  selectionTimeoutMs = 5000,
): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: selectionTimeoutMs });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

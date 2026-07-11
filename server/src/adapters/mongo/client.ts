// Mongo adapter: connection lifecycle only. Models land in Story 1.4 (AD-3).
import mongoose from "mongoose";

export async function connectMongo(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

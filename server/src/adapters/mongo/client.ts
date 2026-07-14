import mongoose from "mongoose";

export async function connectMongo(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

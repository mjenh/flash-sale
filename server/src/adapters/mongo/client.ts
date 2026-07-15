import mongoose from "mongoose";

export async function connectMongo(
  uri: string,
  selectionTimeoutMs = 5_000,
): Promise<typeof mongoose> {
  return mongoose.connect(uri, {
    serverSelectionTimeoutMS: selectionTimeoutMs,
    // Finding #3: explicit pool sizing — Mongoose defaults to maxPoolSize 5,
    // which bottlenecks the write-behind worker's multi-phase bulk writes
    // under sustained load. 20 connections gives the worker headroom for
    // concurrent batches without exhausting the MongoDB connection limit.
    maxPoolSize: 20,
    minPoolSize: 2,
    socketTimeoutMS: 45_000,
    connectTimeoutMS: 10_000,
  });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

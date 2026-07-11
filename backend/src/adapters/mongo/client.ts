// Mongo adapter: connection only. Models land with the domain-schema story (AD-3).
import mongoose from "mongoose";

export async function connectMongo(url: string): Promise<typeof mongoose> {
  return mongoose.connect(url, { serverSelectionTimeoutMS: 5000 });
}

export function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

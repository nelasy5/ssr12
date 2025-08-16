import { createClient, RedisClientType } from "redis";

export class RedisService {
    private client!: RedisClientType;
  
    async start() {
        await this.client.connect()
    }
}

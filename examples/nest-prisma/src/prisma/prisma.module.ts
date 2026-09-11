import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'

/**
 * `@Global()` so every feature module can inject PrismaService without
 * importing PrismaModule. Use this sparingly — a database client and a config
 * service are the two cases where it is genuinely right.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}

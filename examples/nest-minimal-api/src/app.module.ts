/**
 * A module is the unit Nest resolves dependencies inside. `providers` are
 * constructable inside this module; `controllers` get their constructor
 * arguments from those providers. Nothing is global unless you say so.
 */
import { Module } from '@nestjs/common'
import { AppController } from './app.controller.js'
import { AppService } from './app.service.js'

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

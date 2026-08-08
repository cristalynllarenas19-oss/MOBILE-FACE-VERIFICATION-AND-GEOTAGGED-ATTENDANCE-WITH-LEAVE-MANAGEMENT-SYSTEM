import { Module } from "@nestjs/common";
import { UndertimeController } from "./undertime.controller";
import { UndertimeService } from "./undertime.service";

@Module({
  controllers: [UndertimeController],
  providers: [UndertimeService],
})
export class UndertimeModule {}

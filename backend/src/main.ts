console.log("MAIN.TS LOADED");


import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";



async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api/v1");

  app.use(helmet());
console.log("🔥 MAIN.TS LOADED");

  const origins =
    process.env.WEB_ORIGIN?.split(",") ?? [];

  console.log("ALLOWED ORIGINS:");
  console.log(origins);

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  });

  const port = Number(process.env.API_PORT) || 3001;

  await app.listen(port, "0.0.0.0");

  console.log(`Backend running on port ${port}`);
  console.log(`madikon ketnana. magiging tambay lang din naman`);
  console.log(`pabasbas ng programming skills, li xun`);
}
bootstrap();

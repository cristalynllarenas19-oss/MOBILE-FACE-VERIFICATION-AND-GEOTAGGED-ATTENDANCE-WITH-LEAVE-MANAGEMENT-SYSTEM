console.log("MAIN.TS LOADED");


import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module";



async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api/v1");

  app.use(json({ limit: "10mb" }));
  app.use(urlencoded({ extended: true, limit: "10mb" }));
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
console.log("🔥 MAIN.TS LOADED");

  const origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    ...(process.env.WEB_ORIGIN?.split(",") ?? []),
  ].map((origin) => origin.trim()).filter(Boolean);

  const isLocalDevOrigin = (origin: string) =>
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ||
    /^http:\/\/(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+):\d+$/.test(origin);

  console.log("ALLOWED ORIGINS:");
  console.log(origins);

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || origins.includes(origin) || isLocalDevOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port, "0.0.0.0");
  console.log(`Backend running on port ${port}`);
  console.log(`madikon ketnana. magiging tambay lang din naman`);
  console.log(`pabasbas ng programming skills, li xun`);
}
bootstrap();

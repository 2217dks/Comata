// Vercel serverless entry point (see vercel.json in this directory).
import { handle } from "hono/vercel";
import app from "../src/app";

export default handle(app);

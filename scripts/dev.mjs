import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 沿用项目的固定端口；占用时直接说明，不让 Next.js 自动递增端口。
const probe = net.createServer();
probe.once("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "4173 端口已被占用，请复用已有项目服务；静态预览执行 npm run build 即可更新。"
      : error.message,
  );
  process.exitCode = 1;
});
probe.listen(4173, "127.0.0.1", () =>
  probe.close(() => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../node_modules/next/dist/bin/next", import.meta.url),
        ),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "4173",
      ],
      { stdio: "inherit" },
    );
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
  }),
);

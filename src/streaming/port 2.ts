import { createSocket } from "node:dgram";

/**
 * Asks the OS for a free UDP port by binding to port 0 and reading the assigned
 * port number. Cheap, deterministic, and zero-dependency.
 *
 * The port is released as soon as we close the temporary socket — we hand the
 * number back to ffmpeg, which races to bind it. In practice the kernel's "do
 * not reissue this port for a few ms" behaviour avoids collisions, matching
 * what the `pick-port` package does internally.
 */
export async function pickUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(0, "0.0.0.0", () => {
      const addr = socket.address();
      socket.close(() => {
        if (typeof addr === "string" || typeof addr.port !== "number") {
          reject(new Error("Failed to determine UDP port"));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

import type { MetadataRoute } from "next";

/**
 * Makes the dashboard installable, and gives Android something better than a
 * screenshot of the tab to put on a home screen. The icons come from
 * `pnpm brand`; the maskable one carries the extra padding a launcher needs
 * when it crops the tile to its own shape.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fourier",
    short_name: "Fourier",
    description: "Open source product analytics on ClickHouse.",
    start_url: "/",
    display: "standalone",
    background_color: "#141414",
    theme_color: "#141414",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

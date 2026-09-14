import type { Metadata } from "next";
import { FourierProvider } from "fourier/next";
import "./globals.css";

export const metadata: Metadata = { title: "Fourier demo app" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* This is the whole integration. Page views are tracked on every route change. */}
        <FourierProvider
          writeKey={process.env.NEXT_PUBLIC_FOURIER_WRITE_KEY ?? ""}
          host={process.env.NEXT_PUBLIC_FOURIER_HOST ?? "http://localhost:5050"}
          debug
        >
          {children}
        </FourierProvider>
      </body>
    </html>
  );
}

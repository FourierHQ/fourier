import { Suspense, createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Fourier, getFourier, init, type FourierOptions } from "./index";

const FourierContext = createContext<Fourier | null>(null);

export interface FourierProviderProps extends FourierOptions {
  children?: ReactNode;
  /** Automatically send a `page` on every route change. Default true. */
  trackPageViews?: boolean;
  /** Reuse an existing client instead of creating one. */
  client?: Fourier;
}

/**
 * Drop into app/layout.tsx:
 *
 *   <FourierProvider writeKey={process.env.NEXT_PUBLIC_FOURIER_WRITE_KEY!} host={process.env.NEXT_PUBLIC_FOURIER_HOST!}>
 *     {children}
 *   </FourierProvider>
 */
export function FourierProvider({ children, trackPageViews = true, client, ...options }: FourierProviderProps) {
  const instance = useMemo(() => client ?? getFourier() ?? init(options), [client, options.writeKey, options.host]);
  return (
    <FourierContext.Provider value={instance}>
      {trackPageViews && (
        <Suspense fallback={null}>
          <PageViewTracker client={instance} />
        </Suspense>
      )}
      {children}
    </FourierContext.Provider>
  );
}

function PageViewTracker({ client }: { client: Fourier }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const last = useRef<string | null>(null);
  useEffect(() => {
    const key = `${pathname}?${searchParams?.toString() ?? ""}`;
    // Deferred so document.title reflects the new route, and so React strict
    // mode's double-invoked effect only produces one page view.
    const t = setTimeout(() => {
      if (last.current === key) return;
      last.current = key;
      void client.page();
    }, 0);
    return () => clearTimeout(t);
  }, [pathname, searchParams, client]);
  return null;
}

/** Access the client anywhere below the provider. */
export function useFourier(): Fourier {
  const ctx = useContext(FourierContext) ?? getFourier();
  if (!ctx) throw new Error("[fourier] useFourier must be used inside <FourierProvider>");
  return ctx;
}

/** alias: reads like analytics-next's hook */
export const useAnalytics = useFourier;

export { Fourier, init, getFourier };
export type { FourierOptions };

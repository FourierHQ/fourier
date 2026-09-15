"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_ENVIRONMENT, ENVIRONMENTS, parseEnvironment, type Environment } from "@fourierhq/core/environments";

const STORAGE_KEY = "fourier.environment";

const EnvironmentContext = createContext<{
  environment: Environment;
  setEnvironment: (env: Environment) => void;
}>({ environment: DEFAULT_ENVIRONMENT, setEnvironment: () => {} });

/**
 * Which environment the dashboard is looking at.
 *
 * Production is always the initial render, on the server and on the first client
 * paint, so the two agree; a stored preference is applied in an effect afterwards.
 * Reading localStorage during render would hydrate-mismatch, and defaulting to
 * anything but production would mean a page could quietly show preview numbers.
 */
export function EnvironmentProvider({ children }: { children: React.ReactNode }) {
  const [environment, setEnv] = useState<Environment>(DEFAULT_ENVIRONMENT);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setEnv(parseEnvironment(stored));
    } catch {
      // Private browsing or blocked storage: production is a fine answer.
    }
  }, []);

  const setEnvironment = useCallback((env: Environment) => {
    setEnv(env);
    try {
      window.localStorage.setItem(STORAGE_KEY, env);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
  }, []);

  return <EnvironmentContext.Provider value={{ environment, setEnvironment }}>{children}</EnvironmentContext.Provider>;
}

export function useEnvironment() {
  return useContext(EnvironmentContext);
}

/** Just the value, for query keys and query strings. */
export function useEnvironmentValue(): Environment {
  return useContext(EnvironmentContext).environment;
}

export { ENVIRONMENTS, DEFAULT_ENVIRONMENT };
export type { Environment };

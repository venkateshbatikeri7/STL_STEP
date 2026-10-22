import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "stl2step-theme";

function readInitialTheme(): Theme {
  const root = document.documentElement.dataset.theme;
  if (root === "light" || root === "dark") return root;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Light/dark theme.
 *
 * The initial value is written to `documentElement` by an inline script in
 * index.html so there is no flash of the wrong theme; this hook only keeps the
 * toggle in sync afterwards.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .getElementById("theme-color")
      ?.setAttribute("content", theme === "dark" ? "#0b0c0e" : "#f6f5f2");
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private browsing modes can throw on localStorage; the theme still works.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}
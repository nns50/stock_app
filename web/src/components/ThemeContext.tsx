import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

// Light/dark theme. The actual colors live in CSS variables (src/index.css);
// this just flips `data-theme` on <html> and remembers the choice. Default is
// dark. An inline script in index.html applies the saved theme before paint so
// there's no flash.

type Theme = 'dark' | 'light';
const KEY = 'app.theme';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* ignore — storage may be unavailable */
  }
  return 'dark';
}

interface ThemeApi {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeApi>({ theme: 'dark', toggle: () => {}, setTheme: () => {} });
export const useTheme = () => useContext(Ctx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return <Ctx.Provider value={{ theme, toggle, setTheme }}>{children}</Ctx.Provider>;
}

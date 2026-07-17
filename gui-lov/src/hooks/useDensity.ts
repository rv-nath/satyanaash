import { useCallback, useEffect, useState } from "react";

export type Density = "compact" | "comfortable";
const KEY = "sat.density";

function read(): Density {
  const v = localStorage.getItem(KEY);
  return v === "comfortable" ? "comfortable" : "compact";
}

export function useDensity() {
  const [density, setDensityState] = useState<Density>(read);

  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
  }, [density]);

  const setDensity = useCallback((d: Density) => {
    localStorage.setItem(KEY, d);
    setDensityState(d);
  }, []);

  return { density, setDensity };
}

import { useState, useCallback } from "react";

export interface HistoryState<T> {
  state: T;
  actionName: string;
  timestamp: number;
}

interface UseHistoryReturn<T> {
  pushState: (state: T, actionName: string) => void;
  undo: () => T | null;
  redo: () => T | null;
  canUndo: boolean;
  canRedo: boolean;
  clear: () => void;
  lastAction: string | null;
}

export function useHistory<T>(
  maxHistorySize: number = 50
): UseHistoryReturn<T> {
  const [history, setHistory] = useState<HistoryState<T>[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);

  const pushState = useCallback(
    (state: T, actionName: string) => {
      setHistory((prev) => {
        // Remove any history after current index (redo stack)
        const newHistory = prev.slice(0, currentIndex + 1);
        
        // Add new state
        newHistory.push({
          state: JSON.parse(JSON.stringify(state)), // Deep clone
          actionName,
          timestamp: Date.now(),
        });

        // Limit history size
        if (newHistory.length > maxHistorySize) {
          newHistory.shift();
          setCurrentIndex(maxHistorySize - 1);
        } else {
          setCurrentIndex(newHistory.length - 1);
        }

        return newHistory;
      });
    },
    [currentIndex, maxHistorySize]
  );

  const undo = useCallback((): T | null => {
    if (currentIndex <= 0) return null;

    const previousIndex = currentIndex - 1;
    setCurrentIndex(previousIndex);
    return history[previousIndex].state;
  }, [currentIndex, history]);

  const redo = useCallback((): T | null => {
    if (currentIndex >= history.length - 1) return null;

    const nextIndex = currentIndex + 1;
    setCurrentIndex(nextIndex);
    return history[nextIndex].state;
  }, [currentIndex, history]);

  const clear = useCallback(() => {
    setHistory([]);
    setCurrentIndex(-1);
  }, []);

  const canUndo = currentIndex > 0;
  const canRedo = currentIndex < history.length - 1;
  const lastAction = currentIndex >= 0 ? history[currentIndex]?.actionName : null;

  return {
    pushState,
    undo,
    redo,
    canUndo,
    canRedo,
    clear,
    lastAction,
  };
}

import { createContext, ReactNode, useContext } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import type { ProviderStatus } from '../api/types';

interface ProviderCtx {
  status: ProviderStatus | undefined;
  loading: boolean;
  reload: () => void;
}

const Ctx = createContext<ProviderCtx>({ status: undefined, loading: true, reload: () => {} });

export function ProviderProvider({ children }: { children: ReactNode }) {
  const { data, loading, reload } = useAsync(() => client.provider(), []);
  return <Ctx.Provider value={{ status: data, loading, reload }}>{children}</Ctx.Provider>;
}

export const useProvider = () => useContext(Ctx);

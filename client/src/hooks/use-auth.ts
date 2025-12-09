import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getQueryFn } from "@/lib/queryClient";

export interface UsageData {
  tier: "anonymous" | "free" | "paying";
  usagePercent: number;
  isAuthenticated: boolean;
}

export interface UserData {
  id: string;
  role: string;
  isPaying: boolean;
  defaultTown?: string;
  isMunicipalStaff?: boolean;
}

export function useAuth() {
  const usageQuery = useQuery<UsageData>({
    queryKey: ["/api/auth/usage"],
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const userQuery = useQuery<UserData | null>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn<UserData | null>({ on401: "returnNull" }),
    retry: false,
    staleTime: 60000,
  });

  const requestMagicLinkMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await apiRequest("POST", "/api/auth/magic-link", { email });
      return res.json();
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/logout", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/usage"] });
    },
  });

  return {
    usage: usageQuery.data,
    user: userQuery.data,
    isLoading: usageQuery.isLoading,
    requestMagicLink: requestMagicLinkMutation.mutateAsync,
    isSendingMagicLink: requestMagicLinkMutation.isPending,
    magicLinkSuccess: requestMagicLinkMutation.isSuccess,
    magicLinkError: requestMagicLinkMutation.error,
    resetMagicLink: requestMagicLinkMutation.reset,
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
    refetchUsage: usageQuery.refetch,
  };
}

import { useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';
import { AuthContext } from './AuthContext';

const ensurePermission = async () => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(
    JSON.parse(localStorage.getItem('session') ?? 'null'),
  );
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();
  const posthogSent = useRef(false);
  const queryClient = useQueryClient();

  // Initialize auth state and set up session listener
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.refreshSession();
        setSession(session);
        localStorage.setItem('session', JSON.stringify(session));
        setUser(session?.user ?? null);
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      localStorage.setItem('session', JSON.stringify(session));
      setUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') {
        navigate('/update-password');
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  // Fetch user's subscription and usage data when user is available
  const { data: userExtraData, isLoading: isUserExtraDataLoading } = useQuery({
    queryKey: ['userExtraData'],
    enabled: !!user,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('user_extradata', {
        user_id_input: user?.id ?? '',
      });

      if (error) throw error;

      return data;
    },
  });

  // Set up real-time subscription for token_balances table to update tokens immediately
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('token-balances-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'token_balances',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          // Invalidate userExtraData query immediately when token balances change
          queryClient.invalidateQueries({ queryKey: ['userExtraData'] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);

  // Fetch user's profile data directly (avoiding circular dependency)
  const { data: profile, isLoading: isProfileLoading } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', user?.id || '')
        .single();

      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  // Initialize notifications preference once on first render after profile loads
  useEffect(() => {
    if (profile?.notifications_enabled) void ensurePermission();
  }, [profile?.notifications_enabled]);

  // Set up real-time subscription for meshes table to update meshData immediately and notify the user
  useEffect(() => {
    if (!user) {
      return;
    }

    // Supabase realtime
    const channel = supabase
      .channel(`mesh-updates-${user.id}`)
      .on(
        'broadcast',
        {
          event: 'mesh-updated',
        },
        async ({ payload }) => {
          if (payload.kind === 'mesh') {
            queryClient.invalidateQueries({
              queryKey: ['meshData', payload.id],
            });
            queryClient.invalidateQueries({ queryKey: ['mesh', payload.id] });
            queryClient.invalidateQueries({ queryKey: ['userExtraData'] });

            if (
              payload.status === 'success' &&
              profile?.notifications_enabled &&
              !window.location.pathname.includes(
                `/editor/${payload.conversation_id}`,
              )
            ) {
              if (await ensurePermission()) {
                const notification = new Notification('3D model is ready', {
                  body: 'Your generated 3D model has finished. Click to open.',
                  icon: `${import.meta.env.BASE_URL}/Adam-Logo.png`,
                });
                notification.onclick = () => {
                  window.focus();
                  navigate(`/editor/${payload.conversation_id}`);
                  notification.close();
                };
              }
            }
          }

          if (payload.kind === 'preview') {
            queryClient.invalidateQueries({
              queryKey: ['preview', payload.id],
            });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient, navigate, profile?.notifications_enabled]);

  // Track user in PostHog once we have all their data
  useEffect(() => {
    if (
      user &&
      !posthogSent.current &&
      !isUserExtraDataLoading &&
      !isProfileLoading
    ) {
      posthog.identify(user.id, {
        email: user.email,
        full_name: profile?.full_name,
        subscription: userExtraData?.sublevel ?? 'free',
        has_trialed: userExtraData?.hasTrialed ?? false,
      });
      posthogSent.current = true;
    }
  }, [user, isUserExtraDataLoading, userExtraData, profile, isProfileLoading]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
  };

  const signUp = async (email: string, password: string, name: string) => {
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } },
    });
    if (signUpError) throw signUpError;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const signInWithMagicLink = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) throw error;
  };

  const verifyOtp = async (email: string, token: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });
    if (error) throw error;
  };

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
  };

  const updatePassword = async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user,
        hasTrialed: userExtraData?.hasTrialed ?? true,
        subscription: userExtraData?.sublevel ?? 'free',
        subscriptionTokens: userExtraData?.subscriptionTokens ?? 0,
        purchasedTokens: userExtraData?.purchasedTokens ?? 0,
        totalTokens: userExtraData?.totalTokens ?? 0,
        subscriptionTokenLimit: userExtraData?.subscriptionTokenLimit ?? 50,
        subscriptionExpiresAt: userExtraData?.subscriptionExpiresAt ?? null,
        // Only consider the initial auth session loading state
        isLoading: isLoading,
        signIn,
        signUp,
        signInWithMagicLink,
        verifyOtp,
        signOut,
        resetPassword,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

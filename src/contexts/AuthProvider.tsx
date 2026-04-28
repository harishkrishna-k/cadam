import { useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';
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

  useEffect(() => {
    if (user) {
      supabase
        .from('profiles')
        .select('*')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data?.notifications_enabled) {
            void ensurePermission();
          }
        });
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      return;
    }

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

            if (
              payload.status === 'success' &&
              window.location.pathname !== `/editor/${payload.conversation_id}`
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
  }, [user, queryClient, navigate]);

  useEffect(() => {
    if (user && !posthogSent.current) {
      supabase
        .from('profiles')
        .select('full_name')
        .eq('user_id', user.id)
        .single()
        .then(({ data: profileData }) => {
          posthog.identify(user.id, {
            email: user.email,
            full_name: profileData?.full_name,
          });
          posthogSent.current = true;
        });
    }
  }, [user]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
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
        isLoading,
        signIn,
        signOut,
        resetPassword,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
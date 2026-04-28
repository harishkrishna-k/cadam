import { useState, useEffect } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { AuthError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useMutation } from '@tanstack/react-query';
import { GoogleIcon } from '@/components/icons/CompanyIcons';
import { validateRedirectUrl } from '@/lib/utils';

export function SignInView() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const {
    signIn,
    session,
    user,
    isLoading: authLoading,
  } = useAuth();
  const { toast } = useToast();

  // Get and validate redirect parameter from URL
  const searchParams = new URLSearchParams(location.search);
  const rawRedirectPath = searchParams.get('redirect');
  const redirectPath = validateRedirectUrl(rawRedirectPath);

  // Redirect to home if already authenticated
  useEffect(() => {
    if (!authLoading && session && user) {
      navigate('/', { replace: true });
    }
  }, [session, user, authLoading, navigate]);

  const { mutate: signInWithGoogle, isPending: isSigningInWithGoogle } =
    useMutation({
      mutationFn: async () => {
        // Use Supabase's built-in redirectTo parameter with validated URL
        const redirectTo =
          redirectPath !== '/'
            ? `${window.location.origin}${redirectPath}`
            : `${window.location.origin}/`;

        await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo,
          },
        });
      },
      onError: (error) => {
        toast({
          title: 'Whoopsies',
          description:
            error instanceof Error ? error.message : 'Something went wrong',
          variant: 'destructive',
        });
      },
    });

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      await signIn(email, password);
      // Navigate to validated redirect path
      navigate(redirectPath);
    } catch (err) {
      const error = err as AuthError;
      const message =
        error.message === 'Invalid login credentials'
          ? 'Invalid email or password'
          : 'An error occurred while signing in';
      setError(message);
      toast({
        title: 'Whoopsies',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-adam-bg-dark p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col gap-4 rounded-lg bg-adam-bg-secondary-dark p-8 shadow-md">
          <div className="mb-4 flex flex-col items-center justify-center">
            <div>
              <img
                src={`${import.meta.env.BASE_URL}/adam-logo-full.svg`}
                alt="Adam Logo"
                className="w-32"
              />
            </div>
          </div>
          <div className="w-full">
            <Button
              onClick={() => signInWithGoogle()}
              className="flex w-full items-center gap-2 hover:bg-adam-blue/10"
              disabled={isSigningInWithGoogle}
            >
              <GoogleIcon className="w-4" />
              <span>Continue with Google</span>
            </Button>
          </div>

          <form
            onSubmit={handleSignIn}
            className="space-y-6"
          >
            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/50 dark:text-red-200">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email" className="text-white">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-gray-700 bg-adam-bg-dark px-4 text-white placeholder:text-gray-400 max-[430px]:text-base"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-white">
                  Password
                </Label>
                <Link
                  to="/reset-password"
                  className="text-sm text-adam-blue hover:text-adam-blue/80"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-gray-700 bg-adam-bg-dark px-4 text-white placeholder:text-gray-400 max-[430px]:text-base"
              />
            </div>

            <Button type="submit" className="w-full p-6" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

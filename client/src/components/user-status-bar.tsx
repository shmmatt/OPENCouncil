import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, LogOut, Loader2, Mail, CheckCircle, Sparkles } from "lucide-react";

function MagicLinkForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const { requestMagicLink, isSendingMagicLink, magicLinkSuccess, magicLinkError, resetMagicLink } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    
    try {
      await requestMagicLink(email);
    } catch (err) {
    }
  };

  if (magicLinkSuccess) {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <CheckCircle className="w-6 h-6 text-primary" />
        </div>
        <div className="text-center">
          <p className="font-medium">Check your email</p>
          <p className="text-sm text-muted-foreground mt-1">
            We sent a sign-in link to {email}
          </p>
        </div>
        <Button 
          variant="ghost" 
          onClick={() => {
            resetMagicLink();
            setEmail("");
          }}
          data-testid="button-try-different-email"
        >
          Try a different email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSendingMagicLink}
          data-testid="input-email"
        />
      </div>
      {magicLinkError && (
        <p className="text-sm text-destructive">
          Failed to send link. Please try again.
        </p>
      )}
      <Button 
        type="submit" 
        className="w-full" 
        disabled={!email.trim() || isSendingMagicLink}
        data-testid="button-send-magic-link"
      >
        {isSendingMagicLink ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Sending...
          </>
        ) : (
          <>
            <Mail className="w-4 h-4 mr-2" />
            Send sign-in link
          </>
        )}
      </Button>
    </form>
  );
}

export function UserStatusBar() {
  const { usage, user, isLoading, logout, isLoggingOut } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tier = usage?.tier || "anonymous";
  const usagePercent = usage?.usagePercent || 0;
  const isAuthenticated = usage?.isAuthenticated || false;

  const tierLabel = tier === "paying" ? "Pro" : tier === "free" ? "Free" : "Guest";
  const progressColor = usagePercent >= 90 ? "bg-destructive" : usagePercent >= 70 ? "bg-yellow-500" : "bg-primary";

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col gap-1 min-w-[120px]">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{tierLabel}</span>
          <span className="text-muted-foreground">{usagePercent}%</span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div 
            className={`h-full ${progressColor} transition-all duration-300`}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
        {usagePercent >= 80 && (
          <p className="text-[10px] text-muted-foreground">
            {!isAuthenticated ? "Sign in for more" : tier !== "paying" ? "Upgrade for more" : "Resets tomorrow"}
          </p>
        )}
      </div>

      {!isAuthenticated ? (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" data-testid="button-sign-in">
              <User className="w-4 h-4 mr-1" />
              Sign in
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Sign in to OPENCouncil</DialogTitle>
              <DialogDescription>
                Get more daily usage and save your conversation history.
              </DialogDescription>
            </DialogHeader>
            <MagicLinkForm onSuccess={() => setDialogOpen(false)} />
          </DialogContent>
        </Dialog>
      ) : tier !== "paying" ? (
        <Button variant="outline" size="sm" data-testid="button-upgrade">
          <Sparkles className="w-4 h-4 mr-1" />
          Upgrade
        </Button>
      ) : null}

      {isAuthenticated && (
        <Button 
          variant="ghost" 
          size="icon" 
          onClick={() => logout()}
          disabled={isLoggingOut}
          data-testid="button-logout"
        >
          {isLoggingOut ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <LogOut className="w-4 h-4" />
          )}
        </Button>
      )}
    </div>
  );
}

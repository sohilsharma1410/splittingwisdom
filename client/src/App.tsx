import { Switch, Route } from "wouter";
import { AppShell } from "@/components/shell/app-shell";
import { ProtectedRoute } from "@/components/protected-route";
import Dashboard from "@/pages/dashboard";
import Groups from "@/pages/groups";
import GroupDetail from "@/pages/group-detail";
import Activity from "@/pages/activity";
import Balances from "@/pages/balances";
import BalanceDetail from "@/pages/balance-detail";
import BillDetail from "@/pages/bill-detail";
import Login from "@/pages/login";
import Register from "@/pages/register";
import JoinGroup from "@/pages/join-group";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/join/:token" component={JoinGroup} />

      <Route path="/">
        <ProtectedRoute>
          <AppShell>
            <Dashboard />
          </AppShell>
        </ProtectedRoute>
      </Route>
      <Route path="/groups">
        <ProtectedRoute>
          <AppShell>
            <Groups />
          </AppShell>
        </ProtectedRoute>
      </Route>
      <Route path="/group/:id">
        <ProtectedRoute>
          <AppShell>
            <GroupDetail />
          </AppShell>
        </ProtectedRoute>
      </Route>
      <Route path="/activity">
        <ProtectedRoute>
          <AppShell>
            <Activity />
          </AppShell>
        </ProtectedRoute>
      </Route>
      <Route path="/balances">
        <ProtectedRoute>
          <AppShell>
            <Balances />
          </AppShell>
        </ProtectedRoute>
      </Route>
      <Route path="/balance/:id">
        <ProtectedRoute>
          <AppShell>
            <BalanceDetail />
          </AppShell>
        </ProtectedRoute>
      </Route>
      <Route path="/bill/:id">
        <ProtectedRoute>
          <AppShell>
            <BillDetail />
          </AppShell>
        </ProtectedRoute>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

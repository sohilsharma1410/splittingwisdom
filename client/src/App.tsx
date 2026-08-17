import { Switch, Route } from "wouter";
import { AppShell } from "@/components/shell/app-shell";
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
        <AppShell>
          <Dashboard />
        </AppShell>
      </Route>
      <Route path="/groups">
        <AppShell>
          <Groups />
        </AppShell>
      </Route>
      <Route path="/group/:id">
        <AppShell>
          <GroupDetail />
        </AppShell>
      </Route>
      <Route path="/activity">
        <AppShell>
          <Activity />
        </AppShell>
      </Route>
      <Route path="/balances">
        <AppShell>
          <Balances />
        </AppShell>
      </Route>
      <Route path="/balance/:id">
        <AppShell>
          <BalanceDetail />
        </AppShell>
      </Route>
      <Route path="/bill/:id">
        <AppShell>
          <BillDetail />
        </AppShell>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

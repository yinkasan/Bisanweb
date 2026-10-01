import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Protected from './components/Protected.jsx';

import LoginPage from './pages/LoginPage.jsx';
import GlobalDashboardPage from './pages/GlobalDashboardPage.jsx';
import DepotDashboardPage from './pages/DepotDashboardPage.jsx';
import FlowPage from './pages/FlowPage.jsx';
import { FLOW_PAGE_CONFIGS } from './pages/flowConfigs.js';
import AccountsPage from './pages/AccountsPage.jsx';
import AccountDetailPage from './pages/AccountDetailPage.jsx';
import StockPage from './pages/StockPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import NotificationsPage from './pages/NotificationsPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import RolesPage from './pages/RolesPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<Protected><Layout /></Protected>}>
        <Route path="/" element={
          <Protected pageKey="dashboard_global"><GlobalDashboardPage /></Protected>
        } />
        <Route path="/depot" element={
          <Protected pageKey="dashboard_depot"><DepotDashboardPage /></Protected>
        } />

        {/* Financial input pages — one shared component, seven configs */}
        {Object.values(FLOW_PAGE_CONFIGS).map((cfg) => (
          <Route
            key={cfg.path}
            path={cfg.path}
            element={
              <Protected pageKey={cfg.pageKey}>
                <FlowPage config={cfg} />
              </Protected>
            }
          />
        ))}

        <Route path="/customers" element={
          <Protected pageKey="customers"><AccountsPage kind="customers" /></Protected>
        } />
        <Route path="/customers/:id" element={
          <Protected pageKey="customers"><AccountDetailPage kind="customers" /></Protected>
        } />
        <Route path="/suppliers" element={
          <Protected pageKey="suppliers"><AccountsPage kind="suppliers" /></Protected>
        } />
        <Route path="/suppliers/:id" element={
          <Protected pageKey="suppliers"><AccountDetailPage kind="suppliers" /></Protected>
        } />

        <Route path="/stock" element={
          <Protected pageKey="stock_balance"><StockPage /></Protected>
        } />
        <Route path="/reports" element={
          <Protected pageKey="reports"><ReportsPage /></Protected>
        } />
        <Route path="/audit" element={
          <Protected pageKey="audit_trail"><AuditPage /></Protected>
        } />
        <Route path="/notifications" element={
          <Protected pageKey="notifications"><NotificationsPage /></Protected>
        } />
        <Route path="/users" element={
          <Protected pageKey="users"><UsersPage /></Protected>
        } />
        <Route path="/roles" element={
          <Protected pageKey="roles_permissions"><RolesPage /></Protected>
        } />
        <Route path="/settings" element={
          <Protected pageKey="settings"><SettingsPage /></Protected>
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

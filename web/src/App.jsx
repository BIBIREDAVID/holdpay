import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { AuthProvider } from "./lib/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import CreateEscrow from "./pages/CreateEscrow";
import BuyerPay from "./pages/BuyerPay";
import StatusTracker from "./pages/StatusTracker";
import Login from "./pages/Login";
import AdminDashboard from "./pages/AdminDashboard";
import SellerProfile from "./pages/SellerProfile";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login mode="login" />} />
          <Route path="/signup" element={<Login mode="signup" />} />
          <Route path="/pay/:token" element={<BuyerPay />} />
          <Route
            path="/admin"
            element={
              <ProtectedRoute showProfileSetup={false}>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <CreateEscrow />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <StatusTracker />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <SellerProfile />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1>Page not found</h1>
      <Link to="/">Back to HoldPay</Link>
    </div>
  );
}
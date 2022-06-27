import { useEffect } from "react";
import { useAppContext } from "client";
import { LoginInterface } from "client/components";

const Login = () => {
  const { user, router } = useAppContext();

  useEffect(() => {
    if (user && router) router.go("/");
  }, [user, router]);

  return (
    <div className="Login">
      <LoginInterface />
    </div>
  );
};

export default Login;

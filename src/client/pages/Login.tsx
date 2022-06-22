import { useContext, useEffect } from "react";
import { Context } from "client";
import { LoginInterface } from "client/components";

const Login = () => {
  const { user, router } = useContext(Context);

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

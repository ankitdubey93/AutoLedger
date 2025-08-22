import Logo from '../../public/Logo-text-big.png';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { login, register } from '../services/fetchServices';

const HomePage: React.FC = () => {


    const [isLogin, setIsLogin] = useState<boolean>(true);
    const [error, setError] = useState("");

    const [formData, setFormData] = useState({
        name: "",
        email: "",
        password: "",
        confirmPassword: "",
    });

    const { setIsLoggedIn, setUser, isLoggedIn } = useAuth();
    const navigate = useNavigate();

    

    useEffect(() => {
        if(isLoggedIn) {
            navigate("/dashboard", {replace: true});
        }
    }, [isLoggedIn, navigate]);

      const toggleMode = () => {
    setIsLogin((prev) => !prev);
    setFormData({ name: "", email: "", password: "", confirmPassword: "" });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if(!isLogin && formData.password !== formData.confirmPassword) {
        setError("Passwords do not match.");
        return;
    }

    try {
        if(isLogin) {
            const response = await login(formData.email, formData.password);
            if(response.ok) {
                setIsLoggedIn(true);
                setUser(response.user);
                navigate("/dashboard");

            } else {
                setError(response.message || "Login Failed");
            }

        }
        else {
            const response = await register(
                formData.name,
                formData.email,
                formData.password
            );
            if(response && response.user) {
                setIsLoggedIn(true);
                setUser(response.user);
                navigate("/dashboard");
            } else {
                setError(response.message || "Registration Failed.")
            }
        }
    }
    catch (error) {
        console.error("Auth Error:", error);
    }
  }

   

    return (
        <div className="flex flex-col items-center justify-start">
            <div>
                <img
                    width={200}
                    src={Logo}
                    alt="AutoLedger Logo"
                    className="max-w-xs mx-auto"
                />
            </div>
            <div className="bg-white p-8 rounded-md shadow-md w-96 mt-4">
                 <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <input
                type="text"
                name="name"
                placeholder="Full Name"
                onChange={handleChange}
                value={formData.name}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition"
                required
              />
            )}
            <input
              type="email"
              name="email"
              placeholder="Email Address"
              onChange={handleChange}
              value={formData.email}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition"
              required
            />
            <input
              type="password"
              name="password"
              placeholder="Password"
              onChange={handleChange}
              value={formData.password}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition"
              required
            />
            {!isLogin && (
              <input
                type="password"
                name="confirmPassword"
                placeholder="Confirm Password"
                onChange={handleChange}
                value={formData.confirmPassword}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition"
                required
              />
            )}
            <button
  type="submit"
  className="w-full py-3 bg-sky-600 text-white rounded-lg shadow-md hover:bg-sky-700 transition"
>
  {isLogin ? "Login" : "Register"}
</button>
            <p className="text-center mt-5 text-sm text-gray-600">
            {isLogin ? "Don't have an account?" : "Already have an account?"}{" "}
            <button
              onClick={toggleMode}
              className="text-sky-700 font-semibold hover:underline"
            >
              {isLogin ? "Register here" : "Login here"}
            </button>
          </p>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          </form>
            </div>
        </div>
    );
};

export default HomePage;

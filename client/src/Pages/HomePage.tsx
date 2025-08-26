import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { login, register } from "../services/fetchServices";
import {  useNavigate } from "react-router-dom";


const HomePage: React.FC = () => {
  const [isLogIn, setIsLogIn] = useState<boolean>(true);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });


  const navigate = useNavigate();

  const {setIsLoggedIn, setUser, isLoggedIn} = useAuth();

  useEffect(() => {
    if(isLoggedIn) {
      navigate("/dashboard", {replace: true});
    }
  }, [isLoggedIn, navigate]);


  const toggleMode = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLogIn((prev) => !prev);
  };


  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({...formData, [e.target.name]: e.target.value})
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if(!isLogIn && formData.password !== formData.confirmPassword) {
        alert("Passwords do not match.");
        return;
    } 

    try {
      if(isLogIn) {
        const response = await login(formData.email, formData.password);
        if(response.ok) {
          setIsLoggedIn(true);
          setUser(response.user);
          navigate("/dashboard");

        } else {
          alert(response.message || "Login failed.")
        }
      } else {
        const response = await register(
          formData.name,
          formData.email,
          formData.password,
        );

        if(response && response.user) {
          setIsLoggedIn(true);
          setUser(response.user);
          navigate("/dashboard");
           
        } else {
          alert(response.message || "Registration failed.")
        }
      }
 
    } catch (error) {
      console.error("Auth Error:", error);
    }
  };


  return (
    <div className="grid grid-cols-2 min-h-screen bg-gradient-to-br from-black via-gray-900 to-gray-800 text-white">
      {/* Left side logo and description */}
      <div className="flex flex-col justify-center items-center">
        <img src="./AutoLedgerLogo.png" alt="AutoLedger" className="w-128 h-128" />
        <ul className="text-white text-center text-xl space-y-6 max-w-lg p-6 bg-black/20 rounded-2xl shadow-xl backdrop-blur-sm">
          <li>Double Entry Bookkeeping System at your ease.</li>
          <li>Record your expenses and income according to the double-entry bookkeeping system in an interactive way with AutoLedger</li>
        </ul>
      </div>


      {/* Right side Form for registration and logging in */}
      <div className="flex flex-col justify-center items-center">
        <form onSubmit={handleSubmit} className="w-full max-w-sm p-8 rounded-3xl border-6 border-gray-700 bg-gray-900 bg-opacity-80 shadow-lg transition-shadow duration-300 hover:shadow-2xl">
          <h1 className="text-2xl font-bold text-center mb-6 p-2">
            {isLogIn ? "Login to your Account" : "Create an Account"}
          </h1>
          {!isLogIn && (
            <div>


              <label className="font-bold ml-1">Name</label>
              <input
                  type="text"
                  name="name"
                  onChange={handleChange}
                  value={formData.name}
                  placeholder="Full Name"
                  className="w-full px-4 py-2 border-2 rounded-xl bg-gray-800 placeholder-gray-400 text-white"
                  required
                />


            </div>
            
          )}
          <div className="flex flex-col mt-4">
            <label className="font-bold ml-1">Email</label>
            <input
              type="email"
              name="email"
              onChange={handleChange}
              value={formData.email}
              placeholder="Email"
              className="w-full px-4 py-2 border-2 rounded-xl bg-gray-800 placeholder-gray-400 text-white"
            />
          </div>


          <div className="mt-4">
            <label className="font-bold ml-1">Password</label>
            <input
              type="password"
              name="password"
              onChange={handleChange}
              value={formData.password}
              placeholder="Password"
              className="w-full px-4 py-2 border-2 rounded-xl bg-gray-800 placeholder-gray-400 text-white"
            />
          </div>
          {!isLogIn && (
            <div className="mt-4">


              <label className="font-bold ml-1">Cofirm Password</label>
              <input
                  type="password"
                  name="confirmPassword"
                  onChange={handleChange}
                  value={formData.confirmPassword}
                  placeholder="Cofirm Password"
                  className="w-full px-4 py-2 border-2 rounded-xl bg-gray-800 placeholder-gray-400 text-white"
                  required
                />


            </div>
          )}


          <div className="mt-4">
            <button
              type="submit"
              className="w-full bg-gradient-to-r from-gray-800 via-gray-700 to-black text-white py-2 rounded-xl font-bold text-lg shadow-lg transition hover:from-gray-400 hover:to-black"
            >
              {isLogIn ? "Login" : "Register"}
            </button>
          </div>


          <p className="text-center mt-5 text-sm">
            {isLogIn ? "Don't have an account?" : "Already have an account?"}{" "}
            <button onClick={toggleMode} className="font-semibold hover:underline">
              {isLogIn ? "Register here" : "Login here"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
};


export default HomePage;
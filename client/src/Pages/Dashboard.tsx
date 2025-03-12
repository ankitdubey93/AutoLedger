import React,{useState,useEffect} from "react";
import {jwtDecode} from 'jwt-decode';
import {useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";

interface DecodedToken {
    user: {
        id: string;
    };
    iat: number;
    exp: number;
}


const Dashboard:React.FC = () => {

    const [username, setUsername] = useState<string | null>(null);
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(true);
    const navigate = useNavigate();

   
    useEffect(() => {

        const checkAuth = () => {
            const token = localStorage.getItem('token');

        if(!token) {
            setIsAuthenticated(false);
            return;
        }

        try {
            const decoded = jwtDecode<DecodedToken>(token);
            const currentTime = Math.floor(Date.now()/ 1000);


            if(decoded.exp < currentTime) {
                console.warn("Token has expired!");
                localStorage.removeItem("token");
                setIsAuthenticated(false);
                return;
            }

            fetch(`/api/users/${decoded.user.id}`)
                .then((response)=> 
                   { if(response.status === 401) {
                        localStorage.removeItem("token");
                        setIsAuthenticated(false);
                        return null;
                    }
                    return response.json()})
                .then((data) => setUsername(data.username))
                .catch((error) => console.error('Error fetching username: ', error));  
                }

             catch (error) {
                console.error("Error decoding token", error);
                localStorage.removeItem("token");
                setIsAuthenticated(false);
             }   
            };

            checkAuth();

            const interval = setInterval(checkAuth, 5000);
            
            const handleStorageChange = (e: StorageEvent) => {
                if(e.key === "token" && !e.newValue) {
                    setIsAuthenticated(false);
                }
            };

            window.addEventListener("storage", handleStorageChange);

            return () => {
                clearInterval(interval);
                window.removeEventListener("storage", handleStorageChange);
            }
            
        },[]);


        useEffect(() => {
            if(!isAuthenticated) {
                navigate('/');
            }



        }, [isAuthenticated, navigate]);



    const handleSignout = () => {
        localStorage.removeItem('token');
        setIsAuthenticated(false);
    }


    return (
       
<div className="min-h-screen bg-gray-100">
    <header className="bg-blue-600 text-white p-4 flex justify-between items-center">
        <h1 className="text-2xl font-semibold">AutoLedger Dashboard</h1>
        <button onClick={handleSignout} className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded">SignOut</button>
        <nav>
        <ul>
          <li>
            <Link to="/journal-entries">Journal Entries</Link>
          </li>
          {/* Add other dashboard links here */}
        </ul>
      </nav>
    </header>
    <main className="container mx-auto p-4">
        <section className="bg-white p-4 rounded-md shadow-md mb-4">
            <h2 className="text-lg font-semibold mb-2">
                {username ? `Welcome, ${username}!` : `Welcome to your Dashboard!`}
            </h2>
            <p>This is where you will manage your finances.</p>
        </section>
    </main>
</div>
    );
};

export default Dashboard;


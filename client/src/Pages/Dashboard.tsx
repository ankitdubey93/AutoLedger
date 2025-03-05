import React,{useState,useEffect} from "react";
import {jwtDecode} from 'jwt-decode';
import { UNSAFE_getPatchRoutesOnNavigationFunction, useNavigate } from "react-router-dom";

interface DecodedToken {
    user: {
        id: string;
    };
    iat: number;
    exp: number;
}


const Dashboard:React.FC = () => {

    const [username, setUsername] = useState<string | null>(null);
    const navigate = useNavigate();
    
    useEffect(() => {
        const token = localStorage.getItem('token');
        if(token) {
            try {
                const decoded = jwtDecode(token) as DecodedToken;
                fetch(`/api/users/${decoded.user.id}`)
                .then((response)=> response.json())
                .then((data) => setUsername(data.username))
                .catch((error) => console.error('Error fetching username: ', error));  
            }catch (error) {
                console.error('Error decoding token: ', error);
                navigate('/');
            } 
        } else {
            navigate('/');
        }
    }, [navigate]);

    const handleSignout = () => {
        localStorage.removeItem('token');
        navigate('/');
    }


    return (
       
<div className="min-h-screen bg-gray-100">
    <header className="bg-blue-600 text-white p-4 flex justify-between items-center">
        <h1 className="text-2xl font-semibold">AutoLedger Dashboard</h1>
        <button onClick={handleSignout} className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded">SignOut</button>
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


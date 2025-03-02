import { useState } from "react";


interface SignInFormProps {
    onSignIn: (username: string, password: string) => void;
    error?:string;
}

const SignInForm: React.FC<SignInFormProps> = ({onSignIn, error}) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSignIn(username, password);
    };

    return (
        <form className="space-y-4" onSubmit={handleSubmit}>
            {error && <p className="text-red-500 text-sm mb-2">{error}</p>}
            <div>
                <label className="block text-gray-700 text-sm font-bold mb-2">Email</label>
               <input className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline" type="text" placeholder="Your Email Here" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div>
                <label className="block text-gray-700 text-sm font-bold mb-2">Password</label>
                <input className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <div>
                <button className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline w-full">Sign In</button>
            </div>
        </form>
    )
};


export default SignInForm;
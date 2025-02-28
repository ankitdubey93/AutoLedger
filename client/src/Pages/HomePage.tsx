import Logo from '../../public/Logo-text-big.png';
import { useState } from 'react';


const HomePage: React.FC = () => {


    const [isSignUp, setIsSignUp] = useState(false);
    const [username,setUserName] = useState('');
    const [password,setPassword] = useState('');
    const [confirmPassword,setConfirmPassword] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if(isSignUp) {
            console.log('Signing up:', {username, password, confirmPassword});
        } else {
            console.log('Logging in : ', {username,password});
        }
    }
    

    return (
        <div className='min-h-screen flex flex-col items-center justify-center bg-gray-100'>
            <div className='mb-2'>
                <img src={Logo} alt="AutoLedger Logo" className='max-w-xs mx-auto'/>
            </div>
            <div>
            <div className='bg-white p-8 rounded-md shadow-md w-96'>
                <h2 className='text-2xl font-semibold mb-4 text-center'>
                   {isSignUp? 'Sign Up': 'Sign In'}
                </h2>
                <form className='space-y-4' onSubmit={handleSubmit}>
                    <div>
                        <label className="block text-gray-700 text-sm font-bold mb-2">
                            Email
                        </label>
                        <input type="text" placeholder="Your Email Here" value={username} onChange={(e) => setUserName(e.target.value)} required />
                    </div>
                    <div>
                        <label className='block text-gray-700 text-sm font-bold mb-2'>
                            Password
                        </label>
                        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                    </div>
                    {isSignUp && (
                        <div className='mb-4'>
                            <label className='block text-gray-700 text-sm font-bold mb-2'>
                                Confirm Password
                            </label>
                            <input className='shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline' type='password' placeholder='Confirm Password' value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}/>
                        </div>
                    )}
                    <div>
                        <button className='bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline w-full' type='submit'>
                            {isSignUp ? 'Sign Up': 'Sign In'}
                        </button>
                    </div>
                </form>
                <p className='text-center mt-4'>
                    {isSignUp ? (
                        <>
                            Already have an account? {''}
                            <button className='text-blue-500 hover:underline' onClick={() => setIsSignUp(false)}>
                                Sign In
                            </button>
                        </>
                    ): (
                        <>
                        Don't have an account? {''}
                        <button className='text-blue-500 hover:underline' onClick={() => setIsSignUp(true)}>
                            Sign Up</button></>
                    )}
                </p>
            </div>
        </div>
        </div>
    );
  }
  

  export default HomePage;
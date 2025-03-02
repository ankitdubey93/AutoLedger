import Logo from '../../public/Logo-text-big.png';
import { useState } from 'react';
import SignInForm from '../components/SignInForm';
import SignUpForm from '../components/SignUpForm';


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
        <div className='flex flex-col items-center justify-center bg-gray-100'>
            <div className='mb-2'>
                <img src={Logo} alt="AutoLedger Logo" className='max-w-xs mx-auto'/>
            </div>
            <div>
            <div className='bg-white p-8 rounded-md shadow-md w-96'>
                <h2 className='text-2xl font-semibold mb-4 text-center'>
                   {isSignUp? 'Sign Up': 'Sign In'}
                </h2>
                {isSignUp? (
                    <SignUpForm/>
                    
                ):(
                    <SignInForm/>
                )}
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
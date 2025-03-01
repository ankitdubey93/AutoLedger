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
    }
}
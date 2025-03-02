# AutoLedger


**AutoLedger SRS Document**

**1. Introduction**

- **1.1 Purpose:**
    - This document outlines the software requirements for the AutoLedger web application, a bookkeeping tool designed to help users manage their financial transactions.
- **1.2 Scope:**
    - This application will provide users with the ability to record, categorize, and track their financial transactions. It will include user authentication, transaction management, and basic reporting features.
    - UI: User Interface
- **1.3 Definitions, Acronyms, and Abbreviations:**
    - SRS: Software Requirements Specification
    - API: Application Programming Interface
    - DB: Database
- **1.4 References:**
    - N/A
- **1.5 Overview:**
    - This document describes the overall functionality, specific requirements, and design considerations for the AutoLedger application.

**2. Overall Description**

- **2.1 Product Perspective:**
    - AutoLedger is a standalone web application accessible through modern web browsers.
- **2.2 Product Functions:**
    - User authentication (sign-up, sign-in).
    - Transaction management (add, edit, delete).
    - Transaction categorization.
    - Basic reporting (transaction history, balance).
- **2.3 User Classes and Characteristics:**
    - Individuals or small business owners who want to manage their finances.
    - Users with basic computer literacy and internet access.
- **2.4 Operating Environment:**
    - Web browsers (Chrome, Firefox, Safari, Edge).
    - Operating systems (Windows, macOS, Linux).
    - Backend Node.js environment.
    - MongoDB database.
- **2.5 Design and Implementation Constraints:**
    - Security considerations for user data.
    - Performance optimization for data retrieval and display.
    - Responsive design for various screen sizes.
- **2.6 User Documentation:**
    - Online help/FAQ section.
    - Potential for video tutorials.
- **2.7 Assumptions and Dependencies:**
    - Reliable internet connection.
    - Users have a basic understanding of bookkeeping principles.

**3. Specific Requirements**

- **3.1 Functional Requirements:**
    - **FR1: User Authentication:**
        - FR1.1: Users shall be able to create a new account (sign-up).
        - FR1.2: Users shall be able to log in with their credentials (sign-in).
        - FR1.3: User shall be able to logout.
    - **FR2: Transaction Management:**
        - FR2.1: Users shall be able to add new transactions with date, amount, description, and category.
        - FR2.2: Users shall be able to edit existing transactions.
        - FR2.3: Users shall be able to delete transactions.
        - FR2.4: Users shall be able to filter transactions by date, category, and type (income/expense).
    - **FR3: Transaction Categorization:**
        - FR3.1: Users shall be able to create and manage transaction categories.
    - **FR4: Reporting:**
        - FR4.1: Users shall be able to view their transaction history.
        - FR4.2: Users shall be able to view their current balance.
- **3.2 Non-Functional Requirements:**
    - **NFR1: Performance:**
        - NFR1.1: The application shall respond to user requests within 2 seconds.
    - **NFR2: Security:**
        - NFR2.1: User passwords shall be securely stored using hashing.
        - NFR2.2: The application shall protect user data from unauthorized access.
    - **NFR3: Usability:**
        - NFR3.1: The application shall have a clean and intuitive UI.
    - **NFR4: Reliability:**
        - NFR4.1: The application shall be available 99% of the time.
        - **NFR4.2: Data Backup and Recovery**
            - NFR4.2.1: The application shall implement automated daily backups of the database.
            - NFR4.2.2: Backups shall be stored in a secure, off-site location or cloud storage.
            - NFR4.2.3: The application shall provide a documented procedure for restoring the database from backups in case of data loss or system failure.
            - NFR4.2.4: The backup solution shall include a way to verify the backup integrity.
            - NFR4.2.5: Restore testing should take place on a monthly basis.
        - **NFR4.3: Failure Handling**
            - NFR4.3.1: The application shall gracefully handle unexpected errors and prevent data corruption.
            - NFR4.3.2: The application shall provide informative error messages to the user in case of failures.
            - NFR4.3.3: The application shall log all critical error messages to the user in case of failures.
            - NFR4.3.4: The application shall log all critical errors and system events for debugging and troubleshooting.

**4. Flowcharts and Diagrams**

- **4.1 User Authentication Flowchart:**
    
    
        `A[User Accesses App] --> B{Existing User?};
        B -- Yes --> C[Sign In Form];
        B -- No --> D[Sign Up Form];
        C --> E{Valid Credentials?};
        D --> F[Create Account];
        E -- Yes --> G[Dashboard];
        E -- No --> C;
        F --> G;
        G --> H[Logout];
        H --> A;`
    
    [User Authentication Flowchart.drawio](attachment:bb1c41ce-9cbf-4d64-bc9c-ac2a6ed3d2f9:User_Authentication_Flowchart.drawio)
    
- **4.2 Transaction Management Flowchart:**
    
    
        `A[User Dashboard] --> B{Add Transaction?};
        B -- Yes --> C[Transaction Form];
        B -- No --> D{Edit Transaction?};
        C --> E[Save Transaction];
        E --> A;
        D -- Yes --> F[Edit Form];
        D -- No --> G[View Transactions];
        F --> E;
        G --> H{Delete Transaction?};
        H -- Yes --> I[Delete Confirmation];
        I --> J[Delete Transaction];
        J --> G;
        H -- No --> A;`
    
    [Transaction Management Flowchart.drawio](attachment:56fe17fa-5060-4f45-b93b-99bb128de60b:Transaction_Management_Flowchart.drawio)
    
- **4.3 Database Schema Diagram:**
    
    
        `USERS {
            string userId PK
            string username
            string password
            string email
        }
        TRANSACTIONS {
            string transactionId PK
            string userId FK
            date transactionDate
            decimal amount
            string description
            string categoryId FK
        }
        CATEGORIES {
            string categoryId PK
            string categoryName
            string userId FK
        }
        USERS ||--o{ TRANSACTIONS : has
        USERS ||--o{ CATEGORIES : has
        CATEGORIES ||--o{ TRANSACTIONS : contains`
    

**5. Database Schemas**

- **5.1 Users Collection:**
    
    `{
        "userId": "string (UUID)",
        "username": "string",
        "password": "string (hashed)",
        "email": "string"
    }`
    
- **5.2 Transactions Collection:**
    
    `{
        "transactionId": "string (UUID)",
        "userId": "string (UUID)",
        "transactionDate": "date",
        "amount": "decimal",
        "description": "string",
        "categoryId": "string (UUID)"
    }`
    
- **5.3 Categories Collection:**
    
    `{
        "categoryId": "string (UUID)",
        "categoryName": "string",
        "userId": "string (UUID)"
    }`
    

**6. UI Mockups**

- (UI mockups for sign-up, sign-in, transaction form, and dashboard screens.)

**7. API Specifications**

- (API endpoint specifications for user authentication, transaction management, and reporting.)

**8. Future Enhancements**

- Advanced reporting and analytics.
- Integration with bank accounts.
- Mobile application.
- Recurring transactions.

**Choice of Database**

**SQL vs. NoSQL: A Quick Overview**

- **SQL (Relational Databases):**
    - Uses structured query language (SQL) for data manipulation.
    - Data is stored in tables with predefined schemas.
    - Excellent for applications with complex relationships and transactional integrity.
    - Examples: PostgreSQL, MySQL, SQL Server.
- **NoSQL (Non-Relational Databases):**
    - Offers flexible schemas and various data models (document, key-value, graph, column-family).
    - Well-suited for applications with evolving data structures and high scalability.
    - Examples: MongoDB, Cassandra, Redis.

**Choosing for AutoLedger**

For our AutoLedger application, we chose **NoSQL (specifically MongoDB)**. Here's why:

1. **Flexibility:**
    - Bookkeeping applications often require evolving data structures. Users might want to add custom fields or categories. MongoDB's schema-less nature allows for easy adaptation.
2. **Development Speed:**
    - NoSQL databases generally require less upfront schema design, which can accelerate development.
    - Since we are using a MERN stack, MongoDB integrates very well.
3. **Scalability:**
    - If our application grows significantly, MongoDB's horizontal scalability can handle large volumes of data and traffic.
4. **Document-Based Model:**
    - MongoDB stores data in JSON-like documents, which aligns well with the object-oriented nature of JavaScript and React. This simplifies data manipulation.
5. **Simplicity:**
    - For the relatively simple data relationships in a bookkeeping application (users, transactions, categories), a document-based NoSQL database is often sufficient.

**Possibility of using both?**

- Yes, we could use both SQL and NoSQL databases in the same application, but it's generally not necessary for AutoLedger's scope.
- We might have considered a hybrid approach if we had:
    - A need for complex, analytical reporting (SQL).
    - Large volumes of unstructured data (NoSQL).
    - However, for this application, it would increase the complexity of the project.

**Reasons against SQL**

- While SQL databases are very powerful, they can become cumbersome when dealing with frequently changing data structures.
- The strict schema enforcement of SQL databases can slow down development in situations where data structures are still evolving.

**In summary:**

- MongoDB's flexibility, scalability, and document-based model make it an ideal choice for your AutoLedger application.
- It simplifies development and aligns well with the MERN stack.
- Using both SQL and NoSQL adds unnecessary complexity for this project.
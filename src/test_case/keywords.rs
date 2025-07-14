use bharat_cafe as bc;
use regex::Regex;
use uuid::Uuid;

/// Substitutes predefined keywords in input text with generated values.
/// 
/// Supported keywords:
/// - $RandomName -> generates random name
/// - $RandomPhone -> generates random phone number
/// - $RandomAddress -> generates random address
/// - $RandomCompany -> generates random company name
/// - $RandomEmail() or $RandomEmail("domain.com") -> generates random email
/// - $UUID -> generates UUID v4
pub fn substitute_keywords(input: &str) -> String {
    let mut output = input.to_string();

    // Replace $RandomName by iterating manually
    let re_name = Regex::new(r"\$RandomName").unwrap();
    while let Some(matched) = re_name.find(&output) {
        let random_name = bc::random_name();
        output = output.replacen(matched.as_str(), &random_name, 1);
    }

    // Replace $RandomPhone by iterating manually
    let re_phone = Regex::new(r"\$RandomPhone").unwrap();
    while let Some(matched) = re_phone.find(&output) {
        let random_phone = bc::random_phone();
        output = output.replacen(matched.as_str(), &random_phone, 1);
    }

    // Replace $RandomAddress by iterating manually
    let re_address = Regex::new(r"\$RandomAddress").unwrap();
    while let Some(matched) = re_address.find(&output) {
        let random_address = bc::random_address();
        output = output.replacen(matched.as_str(), &random_address, 1);
    }

    // Replace $RandomCompany by iterating manually
    let re_company = Regex::new(r"\$RandomCompany").unwrap();
    while let Some(matched) = re_company.find(&output) {
        let random_company = bc::generate_company_name();
        output = output.replacen(matched.as_str(), &random_company, 1);
    }

    // Replace $RandomEmail with optional domain parameter
    let re_email = Regex::new(r#"\$RandomEmail(?:\(\s*(?:"([^"]*)")?\s*\))?"#).unwrap();
    while let Some(matched) = re_email.captures(&output) {
        let domain = matched.get(1).map(|m| m.as_str()); // Capture the domain if present
        let placeholder = matched.get(0).unwrap().as_str(); // Match the entire placeholder
        let replacement = bc::random_email(domain); // Pass domain to random_email, or None for default
        output = output.replacen(placeholder, &replacement, 1); // Replace one occurrence at a time
    }

    // Replace $UUID by manually iterating over matches
    let re_uuid = Regex::new(r"\$UUID").unwrap();
    while let Some(matched) = re_uuid.find(&output) {
        let uuid = Uuid::new_v4().to_string();
        output = output.replacen(matched.as_str(), &uuid, 1);
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_substitute_keywords() {
        let input = "Hello $RandomName, your phone number is $RandomPhone";
        let output = substitute_keywords(input);
        assert!(output.contains("Hello "));
        assert!(!output.contains("$RandomName"));
        assert!(output.contains(", your phone number is "));
        assert!(!output.contains("$RandomPhone"));
    }

    #[test]
    fn test_uuid_substitution_single() {
        let input = "Your unique ID is $UUID.";
        let output = substitute_keywords(input);

        // Ensure the placeholder is replaced
        assert!(!output.contains("$UUID"));

        // Extract the UUID from the output and validate it
        let uuid_part = output.replace("Your unique ID is ", "").replace('.', "");
        assert!(Uuid::parse_str(&uuid_part).is_ok());
    }

    #[test]
    fn test_uuid_substitution_multiple() {
        let input = "First UUID: $UUID, Second UUID: $UUID.";
        let output = substitute_keywords(input);

        // Ensure the placeholders are replaced
        assert!(!output.contains("$UUID"));

        // Extract the two UUIDs
        let parts: Vec<&str> = output.split(", ").collect();
        let first_uuid = parts[0].replace("First UUID: ", "");
        let second_uuid = parts[1].replace("Second UUID: ", "").replace('.', "");

        // Validate both are valid UUIDs
        assert!(Uuid::parse_str(&first_uuid).is_ok());
        assert!(Uuid::parse_str(&second_uuid).is_ok());

        // Ensure the UUIDs are unique
        assert_ne!(first_uuid, second_uuid);
    }

    #[test]
    fn test_email_substitution_multiple() {
        let input = "Email 1: $RandomEmail(), Email 2: $RandomEmail(\"example.com\"), Email 3: $RandomEmail(\"test.com\")";
        let output = substitute_keywords(input);

        // Ensure the placeholders are replaced
        assert!(!output.contains("$RandomEmail()"));
        assert!(!output.contains("$RandomEmail(\"example.com\")"));
        assert!(!output.contains("$RandomEmail(\"test.com\")"));

        // Extract and validate the emails
        let parts: Vec<&str> = output.split(", ").collect();
        let email1 = parts[0].replace("Email 1: ", "");
        let email2 = parts[1].replace("Email 2: ", "");
        let email3 = parts[2].replace("Email 3: ", "");

        // Validate that each output is a valid email
        assert!(email1.contains('@'));
        assert!(email2.contains("@example.com"));
        assert!(email3.contains("@test.com"));

        // Ensure the emails are unique
        assert_ne!(email1, email2);
        assert_ne!(email1, email3);
        assert_ne!(email2, email3);
    }

    #[test]
    fn test_random_company_substitution() {
        let input = "Company 1: $RandomCompany, Company 2: $RandomCompany, Company 3: $RandomCompany.";
        let output = substitute_keywords(input);

        // Ensure placeholders are replaced
        assert!(!output.contains("$RandomCompany"));

        // Extract and validate the companies
        let parts: Vec<&str> = output.split(", ").collect();
        let company1 = parts[0].replace("Company 1: ", "");
        let company2 = parts[1].replace("Company 2: ", "");
        let company3 = parts[2].replace("Company 3: ", "").replace('.', "");

        // Ensure the companies are unique
        assert_ne!(company1, company2);
        assert_ne!(company1, company3);
        assert_ne!(company2, company3);
    }

    #[test]
    fn test_random_phone_substitution() {
        let input = "Phone 1: $RandomPhone, Phone 2: $RandomPhone, Phone 3: $RandomPhone.";
        let output = substitute_keywords(input);

        // Ensure placeholders are replaced
        assert!(!output.contains("$RandomPhone"));

        // Extract and validate the phone numbers
        let parts: Vec<&str> = output.split(", ").collect();
        let phone1 = parts[0].replace("Phone 1: ", "");
        let phone2 = parts[1].replace("Phone 2: ", "");
        let phone3 = parts[2].replace("Phone 3: ", "").replace('.', "");

        // Ensure the phone numbers are unique
        assert_ne!(phone1, phone2);
        assert_ne!(phone1, phone3);
        assert_ne!(phone2, phone3);
    }

    #[test]
    fn test_random_address_substitution() {
        let input = "Address 1: $RandomAddress, Address 2: $RandomAddress, Address 3: $RandomAddress.";
        let output = substitute_keywords(input);

        // Ensure placeholders are replaced
        assert!(!output.contains("$RandomAddress"));

        // Extract and validate the addresses
        let parts: Vec<&str> = output.split(", ").collect();
        let address1 = parts[0].replace("Address 1: ", "");
        let address2 = parts[1].replace("Address 2: ", "");
        let address3 = parts[2].replace("Address 3: ", "").replace('.', "");

        // Ensure the addresses are unique
        assert_ne!(address1, address2);
        assert_ne!(address1, address3);
        assert_ne!(address2, address3);
    }

    #[test]
    fn test_random_name_substitution() {
        let input = "Name 1: $RandomName, Name 2: $RandomName, Name 3: $RandomName.";
        let output = substitute_keywords(input);

        // Ensure placeholders are replaced
        assert!(!output.contains("$RandomName"));

        // Extract and validate the names
        let parts: Vec<&str> = output.split(", ").collect();
        let name1 = parts[0].replace("Name 1: ", "");
        let name2 = parts[1].replace("Name 2: ", "");
        let name3 = parts[2].replace("Name 3: ", "").replace('.', "");

        // Ensure the names are unique
        assert_ne!(name1, name2);
        assert_ne!(name1, name3);
        assert_ne!(name2, name3);
    }
}
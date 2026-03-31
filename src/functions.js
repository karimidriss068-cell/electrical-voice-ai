const functions = [
  {
    type: "function",
    function: {
      name: "dispatch_emergency",
      description: "Dispatch an emergency technician immediately. Call this the moment you have the caller's name, phone, and address during an emergency.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's full name" },
          phone: { type: "string", description: "Callback phone number, digits only" },
          address: { type: "string", description: "Service address" },
          issue: { type: "string", description: "Description of the emergency" },
          anyone_in_danger: { type: "boolean", description: "Is anyone in immediate danger" },
          power_out: { type: "boolean", description: "Is power completely out" }
        },
        required: ["name", "phone", "address", "issue"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book a service appointment after collecting and confirming all details with the caller.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's full name" },
          phone: { type: "string", description: "Callback phone number, digits only" },
          address: { type: "string", description: "Service address" },
          service_needed: { type: "string", description: "What electrical service they need" },
          preferred_date: { type: "string", description: "When they want the appointment" },
          preferred_time: { type: "string", description: "morning, afternoon, or evening" },
          access_notes: { type: "string", description: "Gate codes, locked areas, pets, etc." }
        },
        required: ["name", "phone", "address", "service_needed"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_quote",
      description: "Submit a quote request after collecting job details from the caller.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's full name" },
          phone: { type: "string", description: "Callback phone number, digits only" },
          address: { type: "string", description: "Service address" },
          job_description: { type: "string", description: "Detailed description of the work needed" },
          property_type: { type: "string", description: "Residential or commercial" },
          building_age: { type: "string", description: "Approximate age of the building" },
          panel_info: { type: "string", description: "Current panel type/size if known" }
        },
        required: ["name", "phone", "address", "job_description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_job_status",
      description: "Look up the status of an existing job or appointment.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's full name" },
          phone: { type: "string", description: "Callback phone number" },
          booking_name: { type: "string", description: "Name the job was booked under" },
          approximate_date: { type: "string", description: "Approximate date of the booking" }
        },
        required: ["name", "phone"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "transfer_to_human",
      description: "Transfer the caller to a human team member. Use when caller requests a person, is frustrated, or has a complex commercial job.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's full name" },
          phone: { type: "string", description: "Callback phone number" },
          reason: { type: "string", description: "Why they need a human" }
        },
        required: ["name", "phone", "reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description: "End the call. Use this ONLY after you have said your closing words and the caller is satisfied. Do not end the call mid-conversation. Say goodbye first, then call this.",
      parameters: {
        type: "object",
        properties: {
          closing_message: { type: "string", description: "Your final spoken goodbye to the caller" }
        },
        required: ["closing_message"]
      }
    }
  }
];

module.exports = { functions };

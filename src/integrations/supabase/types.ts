export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      filter_presets: {
        Row: {
          created_at: string
          id: string
          name: string
          payload: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          payload: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          payload?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      keyword_exclusion_pool: {
        Row: {
          created_at: string
          id: string
          keyword: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          keyword: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          keyword?: string
          user_id?: string
        }
        Relationships: []
      }
      keyword_pool: {
        Row: {
          created_at: string
          id: string
          keyword: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          keyword: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          keyword?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_attachments: {
        Row: {
          created_at: string
          file_name: string
          file_path: string
          file_type: string
          id: string
          paper_id: string
          size_bytes: number
          user_id: string
        }
        Insert: {
          created_at?: string
          file_name: string
          file_path: string
          file_type: string
          id?: string
          paper_id: string
          size_bytes: number
          user_id: string
        }
        Update: {
          created_at?: string
          file_name?: string
          file_path?: string
          file_type?: string
          id?: string
          paper_id?: string
          size_bytes?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_attachments_paper_id_fkey"
            columns: ["paper_id"]
            isOneToOne: false
            referencedRelation: "papers"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_projects: {
        Row: {
          paper_id: string
          project_id: string
        }
        Insert: {
          paper_id: string
          project_id: string
        }
        Update: {
          paper_id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_projects_paper_id_fkey"
            columns: ["paper_id"]
            isOneToOne: false
            referencedRelation: "papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_projects_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_tags: {
        Row: {
          paper_id: string
          tag_id: string
        }
        Insert: {
          paper_id: string
          tag_id: string
        }
        Update: {
          paper_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_tags_paper_id_fkey"
            columns: ["paper_id"]
            isOneToOne: false
            referencedRelation: "papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      papers: {
        Row: {
          abstract: string | null
          authors: Json | null
          created_at: string
          doi: string | null
          drive_url: string | null
          has_abstract: boolean | null
          id: string
          insert_order: number
          journal: string | null
          journal_url: string | null
          keywords: Json | null
          mesh_terms: Json | null
          notes: string | null
          pmid: string | null
          pubmed_url: string | null
          raw_keywords: Json | null
          raw_study_type: string | null
          search_vector: unknown
          statistical_methods: Json | null
          study_type: string | null
          substances: Json | null
          title: string
          tldr: string | null
          updated_at: string
          user_id: string
          year: number | null
        }
        Insert: {
          abstract?: string | null
          authors?: Json | null
          created_at?: string
          doi?: string | null
          drive_url?: string | null
          has_abstract?: boolean | null
          id?: string
          insert_order?: number
          journal?: string | null
          journal_url?: string | null
          keywords?: Json | null
          mesh_terms?: Json | null
          notes?: string | null
          pmid?: string | null
          pubmed_url?: string | null
          raw_keywords?: Json | null
          raw_study_type?: string | null
          search_vector?: unknown
          statistical_methods?: Json | null
          study_type?: string | null
          substances?: Json | null
          title: string
          tldr?: string | null
          updated_at?: string
          user_id: string
          year?: number | null
        }
        Update: {
          abstract?: string | null
          authors?: Json | null
          created_at?: string
          doi?: string | null
          drive_url?: string | null
          has_abstract?: boolean | null
          id?: string
          insert_order?: number
          journal?: string | null
          journal_url?: string | null
          keywords?: Json | null
          mesh_terms?: Json | null
          notes?: string | null
          pmid?: string | null
          pubmed_url?: string | null
          raw_keywords?: Json | null
          raw_study_type?: string | null
          search_vector?: unknown
          statistical_methods?: Json | null
          study_type?: string | null
          substances?: Json | null
          title?: string
          tldr?: string | null
          updated_at?: string
          user_id?: string
          year?: number | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          pubmed_api_key: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          pubmed_api_key?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          pubmed_api_key?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      study_type_exclusion_pool: {
        Row: {
          created_at: string
          id: string
          study_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          study_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          study_type?: string
          user_id?: string
        }
        Relationships: []
      }
      study_type_pool: {
        Row: {
          created_at: string
          group_name: string | null
          hierarchy_rank: number
          id: string
          specificity_weight: number
          study_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          group_name?: string | null
          hierarchy_rank?: number
          id?: string
          specificity_weight?: number
          study_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          group_name?: string | null
          hierarchy_rank?: number
          id?: string
          specificity_weight?: number
          study_type?: string
          user_id?: string
        }
        Relationships: []
      }
      subscription_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json
          payload: Json
          processed_at: string | null
          provider: string
          provider_event_id: string
          subscription_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          payload: Json
          processed_at?: string | null
          provider: string
          provider_event_id: string
          subscription_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          payload?: Json
          processed_at?: string | null
          provider?: string
          provider_event_id?: string
          subscription_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscription_events_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          canceled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          metadata: Json
          plan: string | null
          provider: string
          provider_customer_id: string | null
          provider_price_id: string | null
          provider_product_id: string | null
          provider_subscription_id: string | null
          quantity: number
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          metadata?: Json
          plan?: string | null
          provider: string
          provider_customer_id?: string | null
          provider_price_id?: string | null
          provider_product_id?: string | null
          provider_subscription_id?: string | null
          quantity?: number
          status: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          metadata?: Json
          plan?: string | null
          provider?: string
          provider_customer_id?: string | null
          provider_price_id?: string | null
          provider_product_id?: string | null
          provider_subscription_id?: string | null
          quantity?: number
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      synonym_pool: {
        Row: {
          canonical_term: string
          created_at: string
          id: string
          synonyms: string[]
          user_id: string
        }
        Insert: {
          canonical_term: string
          created_at?: string
          id?: string
          synonyms?: string[]
          user_id: string
        }
        Update: {
          canonical_term?: string
          created_at?: string
          id?: string
          synonyms?: string[]
          user_id?: string
        }
        Relationships: []
      }
      tags: {
        Row: {
          color: string | null
          created_at: string
          id: string
          name: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          name: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      usage_counters: {
        Row: {
          created_at: string
          feature: string
          id: string
          metadata: Json
          period_end: string | null
          period_start: string
          period_type: string
          reserved: number
          updated_at: string
          used: number
          user_id: string
        }
        Insert: {
          created_at?: string
          feature: string
          id?: string
          metadata?: Json
          period_end?: string | null
          period_start: string
          period_type: string
          reserved?: number
          updated_at?: string
          used?: number
          user_id: string
        }
        Update: {
          created_at?: string
          feature?: string
          id?: string
          metadata?: Json
          period_end?: string | null
          period_start?: string
          period_type?: string
          reserved?: number
          updated_at?: string
          used?: number
          user_id?: string
        }
        Relationships: []
      }
      usage_credits: {
        Row: {
          created_at: string
          expires_at: string | null
          feature: string
          id: string
          metadata: Json
          provider: string | null
          provider_reference_id: string | null
          quantity_granted: number
          quantity_remaining: number
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          feature?: string
          id?: string
          metadata?: Json
          provider?: string | null
          provider_reference_id?: string | null
          quantity_granted: number
          quantity_remaining: number
          source: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          feature?: string
          id?: string
          metadata?: Json
          provider?: string | null
          provider_reference_id?: string | null
          quantity_granted?: number
          quantity_remaining?: number
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_entitlements: {
        Row: {
          ai_lifetime_quota: number
          ai_monthly_quota: number
          billing_customer_id: string | null
          billing_provider: string | null
          billing_subscription_id: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          labs_team_enabled: boolean
          metadata: Json
          paper_limit: number
          plan: string
          plan_status: string
          premium_taxonomy_enabled: boolean
          storage_quota_bytes: number
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_lifetime_quota?: number
          ai_monthly_quota?: number
          billing_customer_id?: string | null
          billing_provider?: string | null
          billing_subscription_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          labs_team_enabled?: boolean
          metadata?: Json
          paper_limit?: number
          plan?: string
          plan_status?: string
          premium_taxonomy_enabled?: boolean
          storage_quota_bytes?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_lifetime_quota?: number
          ai_monthly_quota?: number
          billing_customer_id?: string | null
          billing_provider?: string | null
          billing_subscription_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          labs_team_enabled?: boolean
          metadata?: Json
          paper_limit?: number
          plan?: string
          plan_status?: string
          premium_taxonomy_enabled?: boolean
          storage_quota_bytes?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_storage_usage: {
        Row: {
          created_at: string
          updated_at: string
          used_bytes: number
          user_id: string
        }
        Insert: {
          created_at?: string
          updated_at?: string
          used_bytes?: number
          user_id: string
        }
        Update: {
          created_at?: string
          updated_at?: string
          used_bytes?: number
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bulk_set_paper_projects: {
        Args: { p_paper_ids: string[]; p_project_ids: string[] }
        Returns: undefined
      }
      bulk_set_paper_tags: {
        Args: { p_paper_ids: string[]; p_tag_ids: string[] }
        Returns: undefined
      }
      bulk_update_keywords: { Args: { updates: Json }; Returns: undefined }
      bulk_update_study_types: { Args: { updates: Json }; Returns: undefined }
      consume_ai_quota: {
        Args: { p_user_id: string }
        Returns: {
          allowed: boolean
          period_type: string
          plan: string
          quota: number
          reason: string
          remaining: number
          reset_at: string
          used: number
        }[]
      }
      filter_papers_by_keywords: {
        Args: { p_keywords: string[]; p_user_id: string }
        Returns: {
          paper_id: string
        }[]
      }
      get_duplicate_papers: { Args: never; Returns: Json }
      get_keyword_options: {
        Args: {
          p_paper_ids?: string[]
          p_study_types?: string[]
          p_user_id: string
          p_year_from?: number
          p_year_to?: number
        }
        Returns: {
          keyword: string
        }[]
      }
      immutable_english_tsvector_jsonb: { Args: { j: Json }; Returns: unknown }
      immutable_english_tsvector_text: { Args: { t: string }; Returns: unknown }
      immutable_english_tsvector_textarr: {
        Args: { arr: string[] }
        Returns: unknown
      }
      merge_exact_duplicates: {
        Args: { p_discard_ids: string[]; p_keep_id: string }
        Returns: undefined
      }
      refund_ai_quota: {
        Args: { p_user_id: string }
        Returns: {
          period_type: string
          refunded: boolean
          used: number
        }[]
      }
      safe_bulk_insert_papers: {
        Args: { p_papers: Json; p_user_id: string }
        Returns: Json
      }
      search_papers: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_query: string
          p_user_id: string
        }
        Returns: {
          matched_abstract: boolean
          matched_authors: boolean
          matched_journal: boolean
          matched_keywords: boolean
          matched_notes: boolean
          matched_title: boolean
          paper_id: string
          rank: number
        }[]
      }
      search_papers_short: {
        Args: { p_query: string; p_user_id: string }
        Returns: {
          matched_abstract: boolean
          matched_authors: boolean
          matched_journal: boolean
          matched_keywords: boolean
          matched_notes: boolean
          matched_title: boolean
          paper_id: string
        }[]
      }
      set_paper_projects: {
        Args: { p_paper_id: string; p_project_ids: string[] }
        Returns: undefined
      }
      set_paper_tags: {
        Args: { p_paper_id: string; p_tag_ids: string[] }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
